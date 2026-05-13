#include <algorithm>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <napi.h>

#include "../shared/native-stream.h"

extern "C" {
#include "g722_decoder.h"
#include "g722_encoder.h"
}

namespace {

size_t EstimateG722EncodedBytes(size_t pcmBytes) {
  return (pcmBytes & ~static_cast<size_t>(1)) / 4;
}

size_t EstimateG722DecodedBytes(size_t payloadBytes) {
  return payloadBytes * 4;
}

class G722EncoderWrap : public Napi::ObjectWrap<G722EncoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "G722Encoder",
      {
        InstanceMethod("encodeFrameInto", &G722EncoderWrap::EncodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &G722EncoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &G722EncoderWrap::Close),
      }
    );
  }

  explicit G722EncoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<G722EncoderWrap>(info) {
    const Napi::Env env = info.Env();
    int bitrate = 64000;
    int options = G722_DEFAULT;
    if (info.Length() > 0 && info[0].IsNumber()) bitrate = info[0].As<Napi::Number>().Int32Value();
    if (info.Length() > 1 && info[1].IsNumber()) options = info[1].As<Napi::Number>().Int32Value();
    encoder_ = g722_encoder_new(bitrate, options);
    if (!encoder_) Napi::Error::New(env, "Failed to create G.722 encoder").ThrowAsJavaScriptException();
  }

  ~G722EncoderWrap() override {
    CloseInternal();
  }

private:
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
      *error = "G.722 encoder is closed";
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
    const size_t inputBytes = inputLength & ~static_cast<size_t>(1);
    if (inputBytes < 4) {
      return true;
    }
    const size_t expectedBytes = EstimateG722EncodedBytes(inputBytes);
    if (outputLength < expectedBytes) {
      return true;
    }
    const int sampleCount = static_cast<int>(inputBytes / sizeof(int16_t));
    const int producedBytes = g722_encode(
      encoder_,
      reinterpret_cast<const int16_t*>(inputData),
      sampleCount,
      outputData
    );
    if (producedBytes <= 0) {
      *error = "G.722 encode failed";
      return false;
    }
    *written = static_cast<size_t>(producedBytes);
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
    return Napi::Number::New(env, static_cast<double>(EstimateG722EncodedBytes(inputLength)));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!encoder_) return;
    g722_encoder_destroy(encoder_);
    encoder_ = nullptr;
  }

  G722_ENC_CTX* encoder_ = nullptr;
};

class G722DecoderWrap : public Napi::ObjectWrap<G722DecoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "G722Decoder",
      {
        InstanceMethod("decodeFrameInto", &G722DecoderWrap::DecodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &G722DecoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &G722DecoderWrap::Close),
      }
    );
  }

  explicit G722DecoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<G722DecoderWrap>(info) {
    const Napi::Env env = info.Env();
    int bitrate = 64000;
    int options = G722_DEFAULT;
    if (info.Length() > 0 && info[0].IsNumber()) bitrate = info[0].As<Napi::Number>().Int32Value();
    if (info.Length() > 1 && info[1].IsNumber()) options = info[1].As<Napi::Number>().Int32Value();
    decoder_ = g722_decoder_new(bitrate, options);
    if (!decoder_) Napi::Error::New(env, "Failed to create G.722 decoder").ThrowAsJavaScriptException();
  }

  ~G722DecoderWrap() override {
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
      *error = "G.722 decoder is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      *error = "G.722 payload buffer is required";
      return false;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }
    const size_t expectedBytes = EstimateG722DecodedBytes(inputLength);
    if (outputLength < expectedBytes) {
      return true;
    }
    const int writtenSamples = g722_decode(
      decoder_,
      inputData,
      static_cast<int>(inputLength),
      reinterpret_cast<int16_t*>(outputData)
    );
    if (writtenSamples <= 0) {
      *error = "G.722 decode failed";
      return false;
    }
    *written = static_cast<size_t>(writtenSamples) * sizeof(int16_t);
    return true;
  }

  Napi::Value DecodeFrameIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    uint8_t* outputData = nullptr;
    size_t outputLength = 0;
    if (!NativeGetBufferRange(info, 0, "G.722 payload buffer is required", &inputData, &inputLength)) {
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
    if (!NativeGetBufferRange(info, 0, "G.722 payload buffer is required", &inputData, &inputLength)) {
      return Napi::Number::New(env, 0);
    }
    return Napi::Number::New(env, static_cast<double>(EstimateG722DecodedBytes(inputLength)));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!decoder_) return;
    g722_decoder_destroy(decoder_);
    decoder_ = nullptr;
  }

  G722_DEC_CTX* decoder_ = nullptr;
};

} // namespace

Napi::Object InitG722(Napi::Env env, Napi::Object exports) {
  exports.Set("G722Encoder", G722EncoderWrap::Define(env));
  exports.Set("G722Decoder", G722DecoderWrap::Define(env));
  return exports;
}
