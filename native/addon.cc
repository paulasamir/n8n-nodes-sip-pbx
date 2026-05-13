#include <napi.h>

Napi::Object InitAllNativeCodecs(Napi::Env env, Napi::Object exports);
Napi::Object InitAllNativeFFAudio(Napi::Env env, Napi::Object exports);

Napi::Object InitNativeAddon(Napi::Env env, Napi::Object exports) {
  InitAllNativeCodecs(env, exports);
  InitAllNativeFFAudio(env, exports);
  return exports;
}

NODE_API_MODULE(native, InitNativeAddon)
