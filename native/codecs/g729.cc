#include <algorithm>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <napi.h>

#include "../shared/native-stream.h"

extern "C" {
#include "bcg729/decoder.h"
#include "bcg729/encoder.h"
}

namespace {

constexpr int kG729PcmSamplesPerFrame = 80;
constexpr int kG729VoicePayloadBytes = 10;
constexpr int kG729SidPayloadBytes = 2;
constexpr size_t kG729PcmBytesPerFrame = static_cast<size_t>(kG729PcmSamplesPerFrame) * sizeof(int16_t);

size_t EstimateG729EncodedBytes(size_t pcmBytes) {
  return (pcmBytes / kG729PcmBytesPerFrame) * static_cast<size_t>(kG729VoicePayloadBytes);
}

size_t EstimateG729DecodedBytes(size_t payloadBytes) {
  const size_t voiceFrames = payloadBytes / static_cast<size_t>(kG729VoicePayloadBytes);
  const size_t remainder = payloadBytes % static_cast<size_t>(kG729VoicePayloadBytes);
  const size_t sidFrames = remainder >= static_cast<size_t>(kG729SidPayloadBytes) ? 1 : 0;
  return (voiceFrames + sidFrames) * kG729PcmBytesPerFrame;
}

class G729EncoderWrap : public Napi::ObjectWrap<G729EncoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "G729Encoder",
      {
        InstanceMethod("encodeFrameInto", &G729EncoderWrap::EncodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &G729EncoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &G729EncoderWrap::Close),
      }
    );
  }

  explicit G729EncoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<G729EncoderWrap>(info) {
    const Napi::Env env = info.Env();
    const bool enableVad = info.Length() > 0 && info[0].IsBoolean() ? info[0].As<Napi::Boolean>().Value() : false;
    encoder_ = initBcg729EncoderChannel(enableVad ? 1 : 0);
    if (!encoder_) Napi::Error::New(env, "Failed to create G.729 encoder").ThrowAsJavaScriptException();
  }

  ~G729EncoderWrap() override {
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
      *error = "G.729 encoder is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      return true;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }

    size_t totalWritten = 0;
    size_t consumed = 0;
    while (inputLength - consumed >= kG729PcmBytesPerFrame) {
      if (outputLength - totalWritten < kG729VoicePayloadBytes) {
        break;
      }
      uint8_t payloadLength = 0;
      bcg729Encoder(
        encoder_,
        reinterpret_cast<const int16_t*>(inputData + consumed),
        outputData + totalWritten,
        &payloadLength
      );
      if (payloadLength == 0 || payloadLength > kG729VoicePayloadBytes) {
        *error = "G.729 encode failed";
        return false;
      }
      consumed += kG729PcmBytesPerFrame;
      totalWritten += static_cast<size_t>(payloadLength);
    }

    *written = totalWritten;
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
    return Napi::Number::New(env, static_cast<double>(EstimateG729EncodedBytes(inputLength)));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!encoder_) return;
    closeBcg729EncoderChannel(encoder_);
    encoder_ = nullptr;
  }

  bcg729EncoderChannelContextStruct* encoder_ = nullptr;
};

class G729DecoderWrap : public Napi::ObjectWrap<G729DecoderWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "G729Decoder",
      {
        InstanceMethod("decodeFrameInto", &G729DecoderWrap::DecodeFrameIntoValue),
        InstanceMethod("estimateOutputBytes", &G729DecoderWrap::EstimateOutputBytesValue),
        InstanceMethod("close", &G729DecoderWrap::Close),
      }
    );
  }

  explicit G729DecoderWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<G729DecoderWrap>(info) {
    const Napi::Env env = info.Env();
    decoder_ = initBcg729DecoderChannel();
    if (!decoder_) Napi::Error::New(env, "Failed to create G.729 decoder").ThrowAsJavaScriptException();
  }

  ~G729DecoderWrap() override {
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
      *error = "G.729 decoder is closed";
      return false;
    }
    if (!inputData || inputLength == 0) {
      return true;
    }
    if (!outputData || outputLength == 0) {
      *error = "Target buffer is required";
      return false;
    }

    size_t consumed = 0;
    size_t totalWritten = 0;
    while (consumed < inputLength) {
      const size_t remainingInput = inputLength - consumed;
      const size_t payloadBytes = remainingInput >= static_cast<size_t>(kG729VoicePayloadBytes)
        ? static_cast<size_t>(kG729VoicePayloadBytes)
        : (remainingInput >= static_cast<size_t>(kG729SidPayloadBytes)
          ? static_cast<size_t>(kG729SidPayloadBytes)
          : 0);
      if (payloadBytes == 0 || outputLength - totalWritten < kG729PcmBytesPerFrame) {
        break;
      }
      const uint8_t frameErasure = 0;
      const uint8_t sidFrame = payloadBytes == static_cast<size_t>(kG729SidPayloadBytes) ? 1 : 0;
      const uint8_t rfc3389Payload = 0;
      bcg729Decoder(
        decoder_,
        inputData + consumed,
        static_cast<uint8_t>(payloadBytes),
        frameErasure,
        sidFrame,
        rfc3389Payload,
        reinterpret_cast<int16_t*>(outputData + totalWritten)
      );
      consumed += payloadBytes;
      totalWritten += kG729PcmBytesPerFrame;
    }

    *written = totalWritten;
    return true;
  }

  Napi::Value DecodeFrameIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    uint8_t* inputData = nullptr;
    size_t inputLength = 0;
    uint8_t* outputData = nullptr;
    size_t outputLength = 0;
    if (!NativeGetBufferRange(info, 0, "G.729 payload buffer is required", &inputData, &inputLength)) {
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
    if (!NativeGetBufferRange(info, 0, "G.729 payload buffer is required", &inputData, &inputLength)) {
      return Napi::Number::New(env, 0);
    }
    return Napi::Number::New(env, static_cast<double>(EstimateG729DecodedBytes(inputLength)));
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    if (!decoder_) return;
    closeBcg729DecoderChannel(decoder_);
    decoder_ = nullptr;
  }

  bcg729DecoderChannelContextStruct* decoder_ = nullptr;
};

} // namespace

Napi::Object InitG729(Napi::Env env, Napi::Object exports) {
  exports.Set("G729Encoder", G729EncoderWrap::Define(env));
  exports.Set("G729Decoder", G729DecoderWrap::Define(env));
  return exports;
}
