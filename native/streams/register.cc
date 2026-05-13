#include <napi.h>

Napi::Function InitMediaStream(Napi::Env env);

Napi::Object InitAllNativeFFAudio(Napi::Env env, Napi::Object exports) {
  exports.Set("ffaudioAbiVersion", Napi::Number::New(env, 3));
  exports.Set("MediaStream", InitMediaStream(env));
  return exports;
}
