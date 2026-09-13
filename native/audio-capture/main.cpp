// audio-capture.exe: WASAPI process-loopback capture for ScreenLink.
//
// Streams 48 kHz, stereo, float32 interleaved PCM to stdout.
//   --include-hwnd <HWND>   capture the audio of the process owning that window (and its children)
//   --include-pid  <PID>    capture the audio of that process tree
//   --exclude-pid  <PID>    capture all system audio EXCEPT that process tree
//   --parent-pid   <PID>    exit when this process exits
//
// Status lines go to stderr. Exit codes: 0 = parent exited / stdout closed, 1 = bad args, 2 = WASAPI error.
// Needs Windows 10 2004 (build 19041) or newer. Adapted from Microsoft's ApplicationLoopbackAudio sample.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <fcntl.h>
#include <io.h>

#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <vector>

#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// Local copy of the SDK 10.0.20348+ definitions, so an older Windows SDK still builds this.
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1,
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1,
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;

#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

static void logf(const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);
  fputc('\n', stderr);
  fflush(stderr);
}

// ActivateAudioInterfaceAsync calls back on an MTA thread and requires an agile handler,
// hence IAgileObject. Hand-rolled to avoid a WRL dependency.
class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (client_) client_->Release();
    CloseHandle(done_);
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    IUnknown* unknown = nullptr;
    HRESULT activateHr = E_FAIL;
    result_ = op->GetActivateResult(&activateHr, &unknown);
    if (SUCCEEDED(result_)) result_ = activateHr;
    if (SUCCEEDED(result_) && unknown) {
      result_ = unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client_));
    }
    if (unknown) unknown->Release();
    SetEvent(done_);
    return S_OK;
  }

  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }
  IAudioClient* client() const { return client_; }

 private:
  LONG refs_ = 1;
  HANDLE done_;
  HRESULT result_ = E_PENDING;
  IAudioClient* client_ = nullptr;
};

struct Options {
  DWORD pid = 0;
  PROCESS_LOOPBACK_MODE mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  DWORD parentPid = 0;
};

static bool parseArgs(int argc, wchar_t** argv, Options& opt) {
  bool haveTarget = false;
  for (int i = 1; i + 1 < argc; i += 2) {
    const wchar_t* name = argv[i];
    unsigned long long value = wcstoull(argv[i + 1], nullptr, 10);
    if (wcscmp(name, L"--include-hwnd") == 0) {
      HWND hwnd = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(value));
      DWORD pid = 0;
      GetWindowThreadProcessId(hwnd, &pid);
      if (!pid) {
        logf("error: no process owns window %llu", value);
        return false;
      }
      opt.pid = pid;
      opt.mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
      haveTarget = true;
    } else if (wcscmp(name, L"--include-pid") == 0) {
      opt.pid = static_cast<DWORD>(value);
      opt.mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
      haveTarget = true;
    } else if (wcscmp(name, L"--exclude-pid") == 0) {
      opt.pid = static_cast<DWORD>(value);
      opt.mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
      haveTarget = true;
    } else if (wcscmp(name, L"--parent-pid") == 0) {
      opt.parentPid = static_cast<DWORD>(value);
    } else {
      logf("error: unknown argument %ls", name);
      return false;
    }
  }
  return haveTarget && opt.pid != 0;
}

int wmain(int argc, wchar_t** argv) {
  Options opt;
  if (!parseArgs(argc, argv, opt)) {
    logf("usage: audio-capture (--include-hwnd H | --include-pid P | --exclude-pid P) [--parent-pid P]");
    return 1;
  }
  _setmode(_fileno(stdout), _O_BINARY);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    logf("error: CoInitializeEx hr=0x%08lx", hr);
    return 2;
  }

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = opt.pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = opt.mode;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ActivationHandler* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
                                   &activateParams, handler, &op);
  if (FAILED(hr)) {
    logf("error: ActivateAudioInterfaceAsync hr=0x%08lx (needs Windows 10 2004+)", hr);
    return 2;
  }
  WaitForSingleObject(handler->done(), INFINITE);
  if (op) op->Release();
  if (FAILED(handler->result()) || !handler->client()) {
    logf("error: activation failed hr=0x%08lx", handler->result());
    return 2;
  }
  IAudioClient* client = handler->client();

  // Process loopback has no mix format (GetMixFormat returns E_NOTIMPL), so ask for exactly
  // what the renderer's AudioContext uses and let WASAPI convert.
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200000 /* 20 ms buffer, in 100-ns units */, 0, &format, nullptr);
  if (FAILED(hr)) {
    logf("error: IAudioClient::Initialize hr=0x%08lx", hr);
    return 2;
  }
  hr = client->SetEventHandle(sampleReady);
  if (FAILED(hr)) {
    logf("error: SetEventHandle hr=0x%08lx", hr);
    return 2;
  }
  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
  if (FAILED(hr)) {
    logf("error: GetService(IAudioCaptureClient) hr=0x%08lx", hr);
    return 2;
  }

  HANDLE parent = nullptr;
  if (opt.parentPid) parent = OpenProcess(SYNCHRONIZE, FALSE, opt.parentPid);

  hr = client->Start();
  if (FAILED(hr)) {
    logf("error: IAudioClient::Start hr=0x%08lx", hr);
    return 2;
  }
  logf("ready pid=%lu mode=%s", opt.pid,
       opt.mode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE ? "include" : "exclude");

  std::vector<float> silence;
  HANDLE waits[2] = {sampleReady, parent};
  DWORD waitCount = parent ? 2 : 1;
  int exitCode = 0;

  for (;;) {
    DWORD w = WaitForMultipleObjects(waitCount, waits, FALSE, 500);
    if (w == WAIT_OBJECT_0 + 1) break;  // parent exited
    if (w != WAIT_OBJECT_0) continue;   // timeout: no audio right now

    UINT32 packet = 0;
    while (SUCCEEDED(hr = capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      const void* payload = data;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(static_cast<size_t>(frames) * format.nChannels, 0.0f);
        payload = silence.data();
      }
      const bool ok = fwrite(payload, 1, bytes, stdout) == bytes;
      capture->ReleaseBuffer(frames);
      if (!ok) goto done;  // stdout closed: ScreenLink stopped the share
    }
    if (fflush(stdout) != 0) break;
    if (FAILED(hr)) {
      logf("error: capture loop hr=0x%08lx", hr);
      exitCode = 2;
      break;
    }
  }

done:
  client->Stop();
  capture->Release();
  CloseHandle(sampleReady);
  if (parent) CloseHandle(parent);
  handler->Release();
  CoUninitialize();
  return exitCode;
}
