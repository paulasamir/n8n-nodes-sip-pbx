#include <algorithm>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <napi.h>

#include "../shared/native-stream.h"

extern "C" {
#include "opus.h"
}

namespace {

constexpr int kDefaultMaxPayloadBytes = 4000;
constexpr int kMaxPacketMs = 120;

int NormalizeSampleRate(const Napi::CallbackInfo& info, size_t index, int fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    const int value = info[index].As<Napi::Number>().Int32Value();
    if (value > 0) return value;
  }
  return fallback;
}

int NormalizeChannels(const Napi::CallbackInfo& info, size_t index, int fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    const int value = info[index].As<Napi::Number>().Int32Value();
    if (value == 1 || value == 2) return value;
  }
  return fallback;
}

int NormalizeApplication(const Napi::CallbackInfo& info, size_t index, int fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    const int value = info[index].As<Napi::Number>().Int32Value();
    if (value > 0) return value;
  }
  return fallback;
}

int NormalizeOptionInt(Napi::Object options, const char* key, int fallback) {
  if (!options.Has(key)) return fallback;
  const Napi::Value value = options.Get(key);
  if (!value.IsNumber()) return fallback;
  const int normalized = value.As<Napi::Number>().Int32Value();
  return normalized > 0 ? normalized : fallback;
}

bool NormalizeOptionBool(Napi::Object options, const char* key, bool fallback) {
  if (!options.Has(key)) return fallback;
  const Napi::Value value = options.Get(key);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

int SelectOpusFrameSamples(int sampleRate, int availableSamples) {
  const int frameSizes[] = {
    (sampleRate * 60) / 1000,
    sampleRate / 25,
    sampleRate / 50,
    sampleRate / 100,
    sampleRate / 200,
    sampleRate / 400,
  };
  for (int frameSamples : frameSizes) {
    if (frameSamples > 0 && availableSamples >= frameSamples) return frameSamples;
  }
  return 0;
}

size_t EstimateOpusDecoderOutputBytes(const uint8_t* data, size_t length, int sampleRate, int channels) {
  if (!data || length == 0) return 0;
  const int samples = opus_packet_get_nb_samples(data, static_cast<opus_int32>(length), sampleRate);
  if (samples <= 0) return 0;
  return static_cast<size_t>(samples * channels) * sizeof(opus_int16);
}

class OpusEncoderWrap : public Napi::ObjectWrap<OpusEncoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "OpusEncoder",
      {
        InstanceMethod("encodeFrameInto", &OpusEncoderWrap::EncodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &OpusEncoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &OpusEncoderWrap::Close),
      }
    );
  }

  explicit OpusEncoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<OpusEncoderWrap>(info),
      sampleRate_(NormalizeSampleRate(info, 0, 48000)),
      channels_(NormalizeChannels(info, 1, 1)),
      maxPayloadBytes_(kDefaultMaxPayloadBytes) {
    const Napi::Env env = info.Env();
    const int application = NormalizeApplication(info, 2, OPUS_APPLICATION_AUDIO);
    if (info.Length() > 3 && info[3].IsObject()) {
      const Napi::Object options = info[3].As<Napi::Object>();
      maxPayloadBytes_ = NormalizeOptionInt(options, "maxPayloadBytes", kDefaultMaxPayloadBytes);
    }
    int error = OPUS_OK;
    encoder_ = opus_encoder_create(sampleRate_, channels_, application, &error);
    if (!encoder_ || error != OPUS_OK) {
      encoder_ = nullptr;
      Napi::Error::New(env, "Failed to create Opus encoder").ThrowAsJavaScriptException();
      return;
    }
    if (info.Length() > 3 && info[3].IsObject()) ApplyOptions(info[3].As<Napi::Object>());
  }

  ~OpusEncoderWrap() override {
    CloseInternal();
  }

private:
  void ApplyOptions(Napi::Object options) {
    const int bitrate = NormalizeOptionInt(options, "bitrate", 0);
    if (bitrate > 0) opus_encoder_ctl(encoder_, OPUS_SET_BITRATE(bitrate));
    const int complexity = NormalizeOptionInt(options, "complexity", 0);
    if (complexity > 0) opus_encoder_ctl(encoder_, OPUS_SET_COMPLEXITY(complexity));
    if (options.Has("packetLossPerc")) {
      const int packetLossPerc = NormalizeOptionInt(options, "packetLossPerc", 0);
      opus_encoder_ctl(encoder_, OPUS_SET_PACKET_LOSS_PERC(packetLossPerc));
    }
    if (options.Has("signal") && options.Get("signal").IsNumber()) {
      opus_encoder_ctl(encoder_, OPUS_SET_SIGNAL(options.Get("signal").As<Napi::Number>().Int32Value()));
    }
    opus_encoder_ctl(encoder_, OPUS_SET_INBAND_FEC(NormalizeOptionBool(options, "inbandFec", true) ? 1 : 0));
    opus_encoder_ctl(encoder_, OPUS_SET_DTX(NormalizeOptionBool(options, "dtx", false) ? 1 : 0));
    opus_encoder_ctl(encoder_, OPUS_SET_VBR(NormalizeOptionBool(options, "vbr", true) ? 1 : 0));
  }

  bool EncodeFrameInto(
    const uint8_t* inputData,
    size_t inputLength,
    uint8_t* outputData,
    size_t outputLength,
    size_t* written,
    std::string* error) {
    if (!written || !error) return false;
    *written = 0;
    error->clear();
    if (!encoder_) {
      *error = "Opus encoder is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      *error = "PCM buffer is required";
      return false;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }
    const size_t frameUnitBytes = sizeof(opus_int16) * static_cast<size_t>(channels_);
    if (frameUnitBytes == 0 || (inputLength % frameUnitBytes) != 0) {
      *error = "Opus PCM frame is not sample aligned";
      return false;
    }
    const int frameSamples = static_cast<int>(inputLength / frameUnitBytes);
    if (frameSamples <= 0) {
      return true;
    }
    const int encodedBytes = opus_encode(
      encoder_,
      reinterpret_cast<const opus_int16*>(inputData),
      frameSamples,
      outputData,
      static_cast<opus_int32>(outputLength)
    );
    if (encodedBytes < 0) {
      *error = "Opus encode failed";
      return false;
    }
    *written = static_cast<size_t>(encodedBytes);
    return true;
  }

  Napi::Value EncodeFrameIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
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
    if (!EncodeFrameInto(inputData, inputLength, outputData, outputLength, &written, &error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return env.Null();
    }
    return Napi::Number::New(env, static_cast<double>(written));
  }

  Napi::Value EstimateOutputBytesValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) return Napi::Number::New(env, 0);
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    if (!NativeGetBufferRange(info, 0, "PCM buffer is required", &inputData, &inputLength)) {
      return Napi::Number::New(env, 0);
    }
    const int availableSamples = static_cast<int>(inputLength / (sizeof(opus_int16) * channels_));
    const int frameSamples = SelectOpusFrameSamples(sampleRate_, availableSamples);
    return Napi::Number::New(env, static_cast<double>(frameSamples > 0 ? maxPayloadBytes_ : 0));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!encoder_) return;
    opus_encoder_destroy(encoder_);
    encoder_ = nullptr;
  }

  OpusEncoder* encoder_ = nullptr;
  int sampleRate_;
  int channels_;
  int maxPayloadBytes_;
};

class OpusDecoderWrap : public Napi::ObjectWrap<OpusDecoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "OpusDecoder",
      {
        InstanceMethod("decodeFrameInto", &OpusDecoderWrap::DecodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &OpusDecoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &OpusDecoderWrap::Close),
      }
    );
  }

  explicit OpusDecoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<OpusDecoderWrap>(info),
      sampleRate_(NormalizeSampleRate(info, 0, 48000)),
      channels_(NormalizeChannels(info, 1, 1)),
      maxFrameSamples_(std::max(1, (sampleRate_ * kMaxPacketMs) / 1000)) {
    const Napi::Env env = info.Env();
    int error = OPUS_OK;
    decoder_ = opus_decoder_create(sampleRate_, channels_, &error);
    if (!decoder_ || error != OPUS_OK) {
      decoder_ = nullptr;
      Napi::Error::New(env, "Failed to create Opus decoder").ThrowAsJavaScriptException();
      return;
    }
  }

  ~OpusDecoderWrap() override {
    CloseInternal();
  }

private:
  bool DecodeFrameInto(
    const uint8_t* inputData,
    size_t inputLength,
    uint8_t* outputData,
    size_t outputLength,
    size_t* written,
    std::string* error) {
    if (!written || !error) return false;
    *written = 0;
    error->clear();
    if (!decoder_) {
      *error = "Opus decoder is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      *error = "Opus payload buffer is required";
      return false;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }
    const int decodedSamplesEstimate = opus_packet_get_nb_samples(
      inputData,
      static_cast<opus_int32>(inputLength),
      sampleRate_
    );
    if (decodedSamplesEstimate <= 0) {
      *error = "Opus packet sample count is invalid";
      return false;
    }
    const size_t expectedBytes = static_cast<size_t>(decodedSamplesEstimate * channels_) * sizeof(opus_int16);
    if (outputLength < expectedBytes) {
      return true;
    }
    const int decodedSamples = opus_decode(
      decoder_,
      reinterpret_cast<const unsigned char*>(inputData),
      static_cast<opus_int32>(inputLength),
      reinterpret_cast<opus_int16*>(outputData),
      decodedSamplesEstimate,
      0
    );
    if (decodedSamples < 0) {
      *error = "Opus decode failed";
      return false;
    }
    *written = static_cast<size_t>(decodedSamples * channels_) * sizeof(opus_int16);
    return true;
  }

  Napi::Value DecodeFrameIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    uint8_t* outputData = nullptr;
    size_t outputLength = 0;
    if (!NativeGetBufferRange(info, 0, "Opus payload buffer is required", &inputData, &inputLength)) {
      return env.Null();
    }
    if (!NativeGetBufferRange(info, 3, "Target buffer is required", &outputData, &outputLength)) {
      return env.Null();
    }
    size_t written = 0;
    std::string error;
    if (!DecodeFrameInto(inputData, inputLength, outputData, outputLength, &written, &error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return env.Null();
    }
    return Napi::Number::New(env, static_cast<double>(written));
  }

  Napi::Value EstimateOutputBytesValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) return Napi::Number::New(env, 0);
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    if (!NativeGetBufferRange(info, 0, "Opus payload buffer is required", &inputData, &inputLength)) {
      return Napi::Number::New(env, 0);
    }
    return Napi::Number::New(
      env,
      static_cast<double>(EstimateOpusDecoderOutputBytes(inputData, inputLength, sampleRate_, channels_))
    );
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!decoder_) return;
    opus_decoder_destroy(decoder_);
    decoder_ = nullptr;
  }

  OpusDecoder* decoder_ = nullptr;
  int sampleRate_;
  int channels_;
  int maxFrameSamples_;
};

} // namespace

Napi::Object InitOpus(Napi::Env env, Napi::Object exports) {
  exports.Set("OpusEncoder", OpusEncoderWrap::Define(env));
  exports.Set("OpusDecoder", OpusDecoderWrap::Define(env));
  return exports;
}
