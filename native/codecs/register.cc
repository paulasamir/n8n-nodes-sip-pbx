#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <napi.h>

#include "../shared/native-stream.h"

#if defined(__linux__) || defined(__APPLE__)
#include <pthread.h>
#endif

extern "C" {
#include <libavutil/channel_layout.h>
#include <libavutil/mathematics.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

Napi::Object InitG722(Napi::Env env, Napi::Object exports);
Napi::Object InitG729(Napi::Env env, Napi::Object exports);
Napi::Object InitOpus(Napi::Env env, Napi::Object exports);

namespace {

int NormalizePositiveInt(const Napi::CallbackInfo& info, size_t index, int fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    const int value = info[index].As<Napi::Number>().Int32Value();
    if (value > 0) {
      return value;
    }
  }
  return fallback;
}

int NormalizeChannels(const Napi::CallbackInfo& info, size_t index, int fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    const int value = info[index].As<Napi::Number>().Int32Value();
    if (value > 0) {
      return value;
    }
  }
  return fallback;
}

Napi::Value SetThreadName(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return env.Undefined();
  }
  std::string name = info[0].As<Napi::String>().Utf8Value();
  if (name.empty()) {
    return env.Undefined();
  }
  NativeSetThreadName(name);
  return env.Undefined();
}

class Pcm16ConverterWrap : public Napi::ObjectWrap<Pcm16ConverterWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "Pcm16Converter",
      {
        InstanceMethod("convertInto", &Pcm16ConverterWrap::ConvertIntoValue),
        InstanceMethod("estimateOutputBytes", &Pcm16ConverterWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &Pcm16ConverterWrap::Close),
      }
    );
  }

  explicit Pcm16ConverterWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<Pcm16ConverterWrap>(info),
      inputSampleRate_(NormalizePositiveInt(info, 0, 8000)),
      inputChannels_(NormalizeChannels(info, 1, 1)),
      outputSampleRate_(NormalizePositiveInt(info, 2, inputSampleRate_)),
      outputChannels_(NormalizeChannels(info, 3, 1)),
      inputBytesPerFrame_(static_cast<size_t>(std::max(1, inputChannels_)) * sizeof(int16_t)) {
    const Napi::Env env = info.Env();
    av_channel_layout_default(&inputLayout_, inputChannels_);
    av_channel_layout_default(&outputLayout_, outputChannels_);
    if (
      swr_alloc_set_opts2(
        &resampler_,
        &outputLayout_,
        AV_SAMPLE_FMT_S16,
        outputSampleRate_,
        &inputLayout_,
        AV_SAMPLE_FMT_S16,
        inputSampleRate_,
        0,
        nullptr
      ) < 0 || !resampler_
    ) {
      Napi::Error::New(env, "Failed to create PCM resampler").ThrowAsJavaScriptException();
      return;
    }
    const int result = swr_init(resampler_);
    if (result < 0) {
      CloseInternal();
      Napi::Error::New(env, "Failed to initialize PCM resampler").ThrowAsJavaScriptException();
      return;
    }
  }

  ~Pcm16ConverterWrap() override {
    CloseInternal();
  }

private:
  bool ConvertInto(
    const uint8_t* inputData,
    size_t inputLength,
    uint8_t* outputData,
    size_t outputLength,
    size_t* written,
    std::string* error) {
    if (!written || !error) {
      return false;
    }
    *written = 0;
    error->clear();
    if (!resampler_) {
      *error = "PCM resampler is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      return true;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }

    const size_t alignedInputBytes = inputLength - (inputLength % inputBytesPerFrame_);
    if (alignedInputBytes == 0) {
      return true;
    }
    const int inputFrames = static_cast<int>(alignedInputBytes / inputBytesPerFrame_);
    const int outputFrames = EstimateOutputFrames(inputFrames);
    if (outputFrames <= 0) {
      return true;
    }
    const int outputBytes = av_samples_get_buffer_size(nullptr, outputChannels_, outputFrames, AV_SAMPLE_FMT_S16, 1);
    if (outputBytes < 0) {
      *error = "PCM resampler output sizing failed";
      return false;
    }
    if (static_cast<size_t>(outputBytes) > outputLength) {
      *error = "Target buffer is smaller than converted PCM output";
      return false;
    }

    const uint8_t* inputDataPlanes[1] = {inputData};
    uint8_t* outputDataPlanes[1] = {outputData};
    const int convertedFrames = swr_convert(
      resampler_,
      outputDataPlanes,
      outputFrames,
      inputDataPlanes,
      inputFrames
    );
    if (convertedFrames < 0) {
      *error = "PCM resampler conversion failed";
      return false;
    }

    *written = static_cast<size_t>(convertedFrames) * static_cast<size_t>(outputChannels_) * sizeof(int16_t);
    return true;
  }

  int EstimateOutputFrames(int inputFrames) const {
    if (!resampler_ || inputFrames <= 0) {
      return 0;
    }
    return static_cast<int>(
      av_rescale_rnd(
        swr_get_delay(resampler_, inputSampleRate_) + inputFrames,
        outputSampleRate_,
        inputSampleRate_,
        AV_ROUND_UP
      )
    );
  }

  Napi::Value ConvertIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!resampler_) {
      return env.Null();
    }
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    uint8_t* outputData = nullptr;
    size_t outputLength = 0;
    if (!NativeGetBufferRange(info, 0, "PCM buffer is required", &inputData, &inputLength)) {
      return env.Null();
    }
    if (!NativeGetBufferRange(info, 3, "Target buffer is required", &outputData, &outputLength)) {
      return env.Null();
    }
    size_t written = 0;
    std::string error;
    if (!ConvertInto(inputData, inputLength, outputData, outputLength, &written, &error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return env.Null();
    }
    return Napi::Number::New(env, static_cast<double>(written));
  }

  Napi::Value EstimateOutputBytesValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (!resampler_) {
      return Napi::Number::New(env, 0);
    }
    if (info.Length() < 1 || !info[0].IsBuffer()) {
      return Napi::Number::New(env, 0);
    }
    uint8_t* inputData = nullptr;
    size_t availableInputBytes = 0;
    if (!NativeGetBufferRange(info, 0, "PCM buffer is required", &inputData, &availableInputBytes)) {
      return Napi::Number::New(env, 0);
    }
    const size_t alignedInputBytes = availableInputBytes - (availableInputBytes % inputBytesPerFrame_);
    const int inputFrames = static_cast<int>(alignedInputBytes / inputBytesPerFrame_);
    const int outputFrames = EstimateOutputFrames(inputFrames);
    if (outputFrames <= 0) {
      return Napi::Number::New(env, 0);
    }
    const int outputBytes = av_samples_get_buffer_size(nullptr, outputChannels_, outputFrames, AV_SAMPLE_FMT_S16, 1);
    return Napi::Number::New(env, static_cast<double>(std::max(0, outputBytes)));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (resampler_) {
      swr_free(&resampler_);
    }
    av_channel_layout_uninit(&inputLayout_);
    av_channel_layout_uninit(&outputLayout_);
    resampler_ = nullptr;
  }

  int inputSampleRate_;
  int inputChannels_;
  int outputSampleRate_;
  int outputChannels_;
  size_t inputBytesPerFrame_;
  SwrContext* resampler_ = nullptr;
  AVChannelLayout inputLayout_{};
  AVChannelLayout outputLayout_{};
};

} // namespace

Napi::Object InitAllNativeCodecs(Napi::Env env, Napi::Object exports) {
  exports.Set("SetThreadName", Napi::Function::New(env, SetThreadName, "SetThreadName"));
  InitG722(env, exports);
  InitG729(env, exports);
  InitOpus(env, exports);
  exports.Set("Pcm16Converter", Pcm16ConverterWrap::Define(env));
  return exports;
}
