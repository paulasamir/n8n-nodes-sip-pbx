#include <algorithm>
#include <cmath>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <napi.h>

#include "../shared/native-stream.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

namespace {

constexpr int kDefaultOutputSampleRate = 8000;
constexpr int kDefaultOutputChannels = 1;
constexpr size_t kDefaultInputQueueLimitBytes = 1 << 20;
constexpr int kDefaultAvioBufferBytes = 4096;
constexpr int kDefaultSampleRate = 48000;
constexpr int kDefaultChannels = 1;
constexpr int kDefaultBitrate = 64000;

std::string FfAudioAvErrorToString(int error) {
  char buffer[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(error, buffer, sizeof(buffer));
  return std::string(buffer);
}

int FfAudioReadNumberOption(const Napi::Object& options, const char* key, int fallback) {
  if (!options.Has(key)) return fallback;
  const Napi::Value value = options.Get(key);
  if (!value.IsNumber()) return fallback;
  const int normalized = value.As<Napi::Number>().Int32Value();
  return normalized > 0 ? normalized : fallback;
}

size_t FfAudioReadSizeOption(const Napi::Object& options, const char* key, size_t fallback) {
  if (!options.Has(key)) return fallback;
  const Napi::Value value = options.Get(key);
  if (!value.IsNumber()) return fallback;
  const double raw = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(raw) || raw <= 0) return fallback;
  return static_cast<size_t>(raw);
}

std::string FfAudioReadStringOption(const Napi::Object& options, const char* key, const std::string& fallback) {
  if (!options.Has(key)) return fallback;
  const Napi::Value value = options.Get(key);
  if (!value.IsString()) return fallback;
  const std::string normalized = value.As<Napi::String>().Utf8Value();
  return normalized.empty() ? fallback : normalized;
}

struct OutputPatch {
  size_t offset = 0;
  std::vector<uint8_t> data;
};

AVSampleFormat SelectPreferredSampleFormat(const AVCodecContext* codecContext, const AVCodec* codec) {
  if (!codec) {
    return AV_SAMPLE_FMT_FLTP;
  }
  const void* supportedConfigs = nullptr;
  int supportedConfigCount = 0;
  const int result = avcodec_get_supported_config(
    codecContext,
    codec,
    AV_CODEC_CONFIG_SAMPLE_FORMAT,
    0,
    &supportedConfigs,
    &supportedConfigCount
  );
  if (result < 0 || !supportedConfigs || supportedConfigCount <= 0) {
    return AV_SAMPLE_FMT_FLTP;
  }
  const auto* supportedFormats = static_cast<const AVSampleFormat*>(supportedConfigs);
  for (int index = 0; index < supportedConfigCount; index += 1) {
    if (!av_sample_fmt_is_planar(supportedFormats[index])) {
      return supportedFormats[index];
    }
  }
  return supportedFormats[0];
}

class MediaStreamDecoderState {
 public:
  explicit MediaStreamDecoderState(const Napi::Object& options)
    : containerFormat_(FfAudioReadStringOption(options, "containerFormat", "")),
      outputSampleRate_(FfAudioReadNumberOption(options, "outputSampleRate", kDefaultOutputSampleRate)),
      outputChannels_(std::max(1, FfAudioReadNumberOption(options, "outputChannels", kDefaultOutputChannels))),
      inputQueueLimitBytes_(std::max<size_t>(4096, FfAudioReadSizeOption(options, "inputQueueLimitBytes", kDefaultInputQueueLimitBytes))),
      avioBufferSize_(std::max(1024, FfAudioReadNumberOption(options, "probeBytes", kDefaultAvioBufferBytes))),
      queues_(inputQueueLimitBytes_) {
    av_channel_layout_default(&outputLayout_, outputChannels_);
  }

  ~MediaStreamDecoderState() {
    Close();
  }

  bool ReadFrom(const uint8_t* data, size_t length, size_t* written, std::string* error) {
    return queues_.TryPushInput(
      data,
      length,
      written,
      error,
      "Source buffer is required",
      "Native FFmpeg decoder context is closed",
      "Input chunk exceeds native FFmpeg decoder queue capacity",
      "Native FFmpeg decoder input already closed"
    );
  }

  bool WriteInto(uint8_t* dst, size_t capacity, size_t* bytesRead, std::string* error) {
    if (!bytesRead || !error) return false;
    *bytesRead = 0;
    error->clear();
    if (!dst && capacity > 0) {
      *error = "Target buffer is required";
      return false;
    }

    std::lock_guard<std::mutex> ffmpegLock(ffmpegMutex_);
    if (queues_.IsClosed()) {
      *error = "Native FFmpeg decoder context is closed";
      return false;
    }
    if (!EnsureOpened(error)) return false;
    if (capacity == 0) return true;

    if (queues_.OutputSize() > 0) {
      *bytesRead = queues_.DrainOutput(dst, std::min(capacity, queues_.OutputSize()));
      return true;
    }

    size_t directBytes = 0;
    if (!decodeEof_) {
      if (!ProduceDecodedBytes(error, capacity, dst, capacity, &directBytes)) return false;
    }
    if (directBytes > 0) {
      const size_t remaining = capacity > directBytes ? capacity - directBytes : 0;
      if (remaining > 0 && queues_.OutputSize() > 0) {
        directBytes += queues_.DrainOutput(dst + directBytes, std::min(remaining, queues_.OutputSize()));
      }
      *bytesRead = directBytes;
      return true;
    }

    if (queues_.OutputSize() == 0) return true;
    *bytesRead = queues_.DrainOutput(dst, std::min(capacity, queues_.OutputSize()));
    return true;
  }

  void CloseInput() {
    queues_.CloseInput();
  }

  void Close() {
    queues_.Close();
    std::lock_guard<std::mutex> ffmpegLock(ffmpegMutex_);
    CloseInternal();
  }

  Napi::Object BuildSourceInfo(const Napi::Env& env) const {
    Napi::Object info = Napi::Object::New(env);
    if (sourceSampleRate_ > 0 && sourceChannels_ > 0) {
      info.Set("sampleRate", Napi::Number::New(env, sourceSampleRate_));
      info.Set("channels", Napi::Number::New(env, sourceChannels_));
      info.Set("detectedFormat", detectedFormat_.empty() ? env.Null() : Napi::String::New(env, detectedFormat_));
    } else {
      info.Set("sampleRate", env.Null());
      info.Set("channels", env.Null());
      info.Set("detectedFormat", detectedFormat_.empty() ? env.Null() : Napi::String::New(env, detectedFormat_));
    }
    return info;
  }

private:
  static int ReadPacketTrampoline(void* opaque, uint8_t* buffer, int bufferSize) {
    return opaque ? static_cast<MediaStreamDecoderState*>(opaque)->ReadPacket(buffer, bufferSize) : AVERROR_EOF;
  }

  static std::string NormalizeDetectedFormat(const std::string& raw) {
    if (raw.empty()) return "";
    const auto contains = [&](const char* needle) {
      return raw.find(needle) != std::string::npos;
    };
    if (contains("wav")) return "wav";
    if (contains("mp3")) return "mp3";
    if (contains("flac")) return "flac";
    if (contains("ogg")) return contains("opus") ? "opus" : "ogg";
    if (contains("asf")) return "wma";
    if (contains("amr")) return "amr";
    if (contains("aac")) return "aac";
    if (contains("mov") || contains("mp4") || contains("m4a")) return "m4a";
    if (contains("matroska") || contains("webm")) return "webm";
    return raw;
  }

  bool EnsureOpened(std::string* error) {
    if (decoderOpened_) return true;
    if (!openError_.empty()) {
      *error = openError_;
      return false;
    }

    const AVInputFormat* inputFormat = nullptr;
    if (!containerFormat_.empty()) {
      inputFormat = av_find_input_format(containerFormat_.c_str());
      if (!inputFormat) {
        openError_ = "FFmpeg input format not found: " + containerFormat_;
        *error = openError_;
        return false;
      }
    }

    uint8_t* avioBuffer = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(avioBufferSize_)));
    if (!avioBuffer) {
      openError_ = "Failed to allocate FFmpeg decoder IO buffer";
      *error = openError_;
      return false;
    }

    avioContext_ = avio_alloc_context(
      avioBuffer,
      avioBufferSize_,
      0,
      this,
      &MediaStreamDecoderState::ReadPacketTrampoline,
      nullptr,
      nullptr
    );
    if (!avioContext_) {
      av_free(avioBuffer);
      openError_ = "Failed to allocate FFmpeg decoder AVIO context";
      *error = openError_;
      return false;
    }

    formatContext_ = avformat_alloc_context();
    if (!formatContext_) {
      openError_ = "Failed to allocate FFmpeg format context";
      *error = openError_;
      CloseInternal();
      return false;
    }
    formatContext_->pb = avioContext_;
    formatContext_->flags |= AVFMT_FLAG_CUSTOM_IO;

    int result = avformat_open_input(&formatContext_, nullptr, inputFormat, nullptr);
    if (result < 0) {
      openError_ = "Failed to open FFmpeg decoder input: " + FfAudioAvErrorToString(result);
      *error = openError_;
      CloseInternal();
      return false;
    }

    result = avformat_find_stream_info(formatContext_, nullptr);
    if (result < 0) {
      openError_ = "Failed to inspect FFmpeg input streams: " + FfAudioAvErrorToString(result);
      *error = openError_;
      CloseInternal();
      return false;
    }

    audioStreamIndex_ = av_find_best_stream(formatContext_, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    if (audioStreamIndex_ < 0) {
      openError_ = "Failed to find audio stream in FFmpeg input";
      *error = openError_;
      CloseInternal();
      return false;
    }

    AVStream* stream = formatContext_->streams[audioStreamIndex_];
    if (!stream || !stream->codecpar) {
      openError_ = "FFmpeg audio stream parameters are unavailable";
      *error = openError_;
      CloseInternal();
      return false;
    }

    detectedFormat_ = NormalizeDetectedFormat(
      formatContext_ && formatContext_->iformat && formatContext_->iformat->name
        ? std::string(formatContext_->iformat->name)
        : std::string()
    );

    const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
      openError_ = "FFmpeg audio decoder codec not found";
      *error = openError_;
      CloseInternal();
      return false;
    }

    codecContext_ = avcodec_alloc_context3(codec);
    if (!codecContext_) {
      openError_ = "Failed to allocate FFmpeg decoder codec context";
      *error = openError_;
      CloseInternal();
      return false;
    }
    codecContext_->thread_count = 1;
    codecContext_->thread_type = 0;

    result = avcodec_parameters_to_context(codecContext_, stream->codecpar);
    if (result < 0) {
      openError_ = "Failed to copy FFmpeg stream parameters: " + FfAudioAvErrorToString(result);
      *error = openError_;
      CloseInternal();
      return false;
    }

    result = avcodec_open2(codecContext_, codec, nullptr);
    if (result < 0) {
      openError_ = "Failed to open FFmpeg audio decoder: " + FfAudioAvErrorToString(result);
      *error = openError_;
      CloseInternal();
      return false;
    }

    if (codecContext_->sample_rate <= 0) codecContext_->sample_rate = outputSampleRate_;
    if (codecContext_->ch_layout.nb_channels <= 0) av_channel_layout_default(&codecContext_->ch_layout, 1);

    sourceSampleRate_ = codecContext_->sample_rate;
    sourceChannels_ = codecContext_->ch_layout.nb_channels > 0 ? codecContext_->ch_layout.nb_channels : 1;

    av_channel_layout_uninit(&outputLayout_);
    av_channel_layout_default(&outputLayout_, outputChannels_);
    if (
      swr_alloc_set_opts2(
        &resampler_,
        &outputLayout_,
        AV_SAMPLE_FMT_S16,
        outputSampleRate_,
        &codecContext_->ch_layout,
        codecContext_->sample_fmt,
        codecContext_->sample_rate,
        0,
        nullptr
      ) < 0 || !resampler_
    ) {
      openError_ = "Failed to allocate FFmpeg decoder resampler";
      *error = openError_;
      CloseInternal();
      return false;
    }

    result = swr_init(resampler_);
    if (result < 0) {
      openError_ = "Failed to initialize FFmpeg decoder resampler: " + FfAudioAvErrorToString(result);
      *error = openError_;
      CloseInternal();
      return false;
    }

    frame_ = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (!frame_ || !packet_) {
      openError_ = "Failed to allocate FFmpeg decoder frame or packet";
      *error = openError_;
      CloseInternal();
      return false;
    }

    decoderOpened_ = true;
    return true;
  }

  int ReadPacket(uint8_t* buffer, int bufferSize) {
    if (!buffer || bufferSize <= 0) return AVERROR_EOF;
    size_t drained = 0;
    bool reachedEof = false;
    std::string error;
    if (!queues_.TryDrainInput(buffer, static_cast<size_t>(bufferSize), &drained, &reachedEof, &error, "Native FFmpeg decoder context is closed")) {
      return AVERROR_EOF;
    }
    if (reachedEof) return AVERROR_EOF;
    if (drained == 0) return AVERROR(EAGAIN);
    return static_cast<int>(drained);
  }

  bool ProduceDecodedBytes(
    std::string* error,
    size_t targetBytes,
    uint8_t* directDst = nullptr,
    size_t directCapacity = 0,
    size_t* directWritten = nullptr) {
    if (directWritten) {
      *directWritten = 0;
    }
    const size_t wantedBytes = std::max<size_t>(targetBytes, 1);
    const auto availableBytes = [&]() -> size_t {
      return queues_.OutputSize() + (directWritten ? *directWritten : 0);
    };
    while (availableBytes() < wantedBytes && !decodeEof_) {
      int receiveResult = avcodec_receive_frame(codecContext_, frame_);
      if (receiveResult == 0) {
        const bool canWriteDirect = directDst && directWritten && queues_.OutputSize() == 0 && *directWritten < directCapacity;
        if (!ConvertFrame(
              frame_,
              error,
              canWriteDirect ? directDst : nullptr,
              canWriteDirect ? directCapacity : 0,
              canWriteDirect ? directWritten : nullptr)) {
          av_frame_unref(frame_);
          return false;
        }
        av_frame_unref(frame_);
        continue;
      }
      if (receiveResult == AVERROR_EOF) {
        decodeEof_ = true;
        return true;
      }
      if (receiveResult != AVERROR(EAGAIN)) {
        *error = "FFmpeg decoder frame receive failed: " + FfAudioAvErrorToString(receiveResult);
        return false;
      }

      if (demuxEof_) {
        if (!flushPacketSent_) {
          const int flushResult = avcodec_send_packet(codecContext_, nullptr);
          if (flushResult < 0 && flushResult != AVERROR_EOF && flushResult != AVERROR(EAGAIN)) {
            *error = "FFmpeg decoder flush failed: " + FfAudioAvErrorToString(flushResult);
            return false;
          }
          flushPacketSent_ = true;
        }
        continue;
      }

      const int readResult = av_read_frame(formatContext_, packet_);
      if (readResult == AVERROR_EOF) {
        demuxEof_ = true;
        continue;
      }
      if (readResult == AVERROR(EAGAIN)) {
        return true;
      }
      if (readResult < 0) {
        *error = "FFmpeg decoder read failed: " + FfAudioAvErrorToString(readResult);
        return false;
      }
      if (packet_->stream_index != audioStreamIndex_) {
        av_packet_unref(packet_);
        continue;
      }

      const int sendResult = avcodec_send_packet(codecContext_, packet_);
      av_packet_unref(packet_);
      if (sendResult == AVERROR(EAGAIN)) continue;
      if (sendResult < 0) {
        *error = "FFmpeg decoder packet submit failed: " + FfAudioAvErrorToString(sendResult);
        return false;
      }
    }
    return true;
  }

  bool ConvertFrame(
    AVFrame* frame,
    std::string* error,
    uint8_t* directDst = nullptr,
    size_t directCapacity = 0,
    size_t* directWritten = nullptr) {
    if (!frame || !resampler_) {
      *error = "FFmpeg decoder frame conversion is not initialized";
      return false;
    }

    const int targetFrames = av_rescale_rnd(
      swr_get_delay(resampler_, codecContext_->sample_rate) + frame->nb_samples,
      outputSampleRate_,
      codecContext_->sample_rate,
      AV_ROUND_UP
    );
    if (targetFrames <= 0) return true;

    const int byteCount = av_samples_get_buffer_size(nullptr, outputChannels_, targetFrames, AV_SAMPLE_FMT_S16, 1);
    if (byteCount < 0) {
      *error = "FFmpeg decoder output buffer sizing failed: " + FfAudioAvErrorToString(byteCount);
      return false;
    }

    const size_t alreadyWritten = directWritten ? *directWritten : 0;
    const bool useDirectOutput = directDst
      && directWritten
      && directCapacity >= alreadyWritten
      && static_cast<size_t>(byteCount) <= directCapacity - alreadyWritten;
    if (!useDirectOutput) {
      scratchBuffer_.assign(static_cast<size_t>(byteCount), 0);
    }
    uint8_t* outData[1] = {
      useDirectOutput ? directDst + alreadyWritten : scratchBuffer_.data(),
    };
    const int convertedFrames = swr_convert(
      resampler_,
      outData,
      targetFrames,
      const_cast<const uint8_t**>(frame->extended_data),
      frame->nb_samples
    );
    if (convertedFrames < 0) {
      *error = "FFmpeg decoder resample failed: " + FfAudioAvErrorToString(convertedFrames);
      return false;
    }
    if (convertedFrames <= 0) return true;

    const int convertedBytes = av_samples_get_buffer_size(nullptr, outputChannels_, convertedFrames, AV_SAMPLE_FMT_S16, 1);
    if (convertedBytes < 0) {
      *error = "FFmpeg decoder converted byte sizing failed: " + FfAudioAvErrorToString(convertedBytes);
      return false;
    }

    if (useDirectOutput) {
      *directWritten += static_cast<size_t>(convertedBytes);
      return true;
    }

    queues_.AppendOutput(scratchBuffer_.data(), static_cast<size_t>(convertedBytes));
    return true;
  }

  void CloseInternal() {
    if (packet_) {
      av_packet_free(&packet_);
      packet_ = nullptr;
    }
    if (frame_) {
      av_frame_free(&frame_);
      frame_ = nullptr;
    }
    if (codecContext_) {
      avcodec_free_context(&codecContext_);
      codecContext_ = nullptr;
    }
    if (formatContext_) {
      avformat_close_input(&formatContext_);
      formatContext_ = nullptr;
    }
    if (avioContext_) {
      av_freep(&avioContext_->buffer);
      avio_context_free(&avioContext_);
      avioContext_ = nullptr;
    }
    if (resampler_) {
      swr_free(&resampler_);
    }

    av_channel_layout_uninit(&outputLayout_);
    decoderOpened_ = false;
    demuxEof_ = false;
    flushPacketSent_ = false;
    decodeEof_ = false;
    audioStreamIndex_ = -1;
    sourceSampleRate_ = 0;
    sourceChannels_ = 0;
  }

  std::string containerFormat_;
  std::string detectedFormat_;
  int outputSampleRate_ = kDefaultOutputSampleRate;
  int outputChannels_ = kDefaultOutputChannels;
  size_t inputQueueLimitBytes_ = kDefaultInputQueueLimitBytes;
  int avioBufferSize_ = kDefaultAvioBufferBytes;
  NativeByteQueues queues_;

  std::mutex ffmpegMutex_;
  std::string openError_;
  bool decoderOpened_ = false;
  bool demuxEof_ = false;
  bool flushPacketSent_ = false;
  bool decodeEof_ = false;

  AVIOContext* avioContext_ = nullptr;
  AVFormatContext* formatContext_ = nullptr;
  AVCodecContext* codecContext_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVPacket* packet_ = nullptr;
  SwrContext* resampler_ = nullptr;
  AVChannelLayout outputLayout_{};
  int audioStreamIndex_ = -1;

  int sourceSampleRate_ = 0;
  int sourceChannels_ = 0;
  std::vector<uint8_t> scratchBuffer_;
};

class MediaStreamEncoderState {
 public:
  explicit MediaStreamEncoderState(const Napi::Object& options)
    : codecName_(FfAudioReadStringOption(options, "codecName", "libmp3lame")),
      containerFormat_(FfAudioReadStringOption(options, "containerFormat", "")),
      inputSampleRate_(FfAudioReadNumberOption(options, "inputSampleRate", kDefaultSampleRate)),
      inputChannels_(std::max(1, FfAudioReadNumberOption(options, "inputChannels", kDefaultChannels))),
      outputSampleRate_(FfAudioReadNumberOption(options, "outputSampleRate", inputSampleRate_)),
      outputChannels_(std::max(1, FfAudioReadNumberOption(options, "outputChannels", inputChannels_))),
      bitrate_(FfAudioReadNumberOption(options, "bitrate", kDefaultBitrate)),
      inputQueueLimitBytes_(std::max<size_t>(4096, FfAudioReadSizeOption(options, "inputQueueLimitBytes", kDefaultInputQueueLimitBytes))),
      queues_(inputQueueLimitBytes_) {
    openError_ = OpenCodec();
  }

  ~MediaStreamEncoderState() {
    Close();
  }

  bool ReadFrom(const uint8_t* data, size_t length, size_t* written, std::string* error) {
    if (!openError_.empty()) {
      *error = openError_;
      return false;
    }
    return queues_.TryPushInput(
      data,
      length,
      written,
      error,
      "Source PCM buffer is required",
      "Native FFmpeg encoder context is closed",
      "Input chunk exceeds native FFmpeg encoder queue capacity",
      "Native FFmpeg encoder input already closed"
    );
  }

  bool WriteInto(uint8_t* dst, size_t capacity, size_t* bytesRead, std::string* error) {
    if (!bytesRead || !error) return false;
    *bytesRead = 0;
    error->clear();
    if (!dst && capacity > 0) {
      *error = "Target buffer is required";
      return false;
    }
    if (!openError_.empty()) {
      *error = openError_;
      return false;
    }

    std::lock_guard<std::mutex> ffmpegLock(ffmpegMutex_);
    if (queues_.IsClosed()) {
      *error = "Native FFmpeg encoder context is closed";
      return false;
    }
    if (capacity == 0) return true;

    while (queues_.OutputSize() == 0 && !encodeEof_) {
      const size_t inputSizeBefore = queues_.InputSize();
      const size_t outputSizeBefore = queues_.OutputSize();
      const bool inputClosedBefore = queues_.IsInputClosed();
      const bool inputDrainedBefore = inputDrained_;
      const bool eofBefore = encodeEof_;
      if (!ProduceEncodedBytes(error)) return false;
      if (queues_.OutputSize() > 0 || encodeEof_) break;
      if (
        queues_.InputSize() == inputSizeBefore
        && queues_.OutputSize() == outputSizeBefore
        && queues_.IsInputClosed() == inputClosedBefore
        && inputDrained_ == inputDrainedBefore
        && encodeEof_ == eofBefore
      ) {
        break;
      }
    }

    if (queues_.OutputSize() > 0) {
      *bytesRead = queues_.DrainOutput(dst, std::min(capacity, queues_.OutputSize()));
    }
    return true;
  }

  void CloseInput() {
    queues_.CloseInput();
  }

  void Close() {
    queues_.Close();
    std::lock_guard<std::mutex> ffmpegLock(ffmpegMutex_);
    CloseInternal();
  }

  std::vector<OutputPatch> TakeOutputPatches() {
    std::lock_guard<std::mutex> ffmpegLock(ffmpegMutex_);
    auto patches = std::move(outputPatches_);
    outputPatches_.clear();
    return patches;
  }

private:
  static int WritePacketTrampoline(void* opaque, const uint8_t* buffer, int bufferSize) {
    return opaque ? static_cast<MediaStreamEncoderState*>(opaque)->WritePacket(buffer, bufferSize) : AVERROR(EINVAL);
  }

  static int64_t SeekTrampoline(void* opaque, int64_t offset, int whence) {
    return opaque ? static_cast<MediaStreamEncoderState*>(opaque)->Seek(offset, whence) : AVERROR(EINVAL);
  }

  std::string OpenCodec() {
    codec_ = avcodec_find_encoder_by_name(codecName_.c_str());
    if (!codec_ && codecName_ == "mp3") {
      codec_ = avcodec_find_encoder_by_name("libmp3lame");
    } else if (!codec_ && codecName_ == "opus") {
      codec_ = avcodec_find_encoder_by_name("libopus");
    }
    if (!codec_) return "FFmpeg encoder codec not found: " + codecName_;

    if (!containerFormat_.empty()) {
      const int result = avformat_alloc_output_context2(&formatContext_, nullptr, containerFormat_.c_str(), nullptr);
      if (result < 0 || !formatContext_) {
        CloseInternal();
        return "Failed to allocate FFmpeg output context: " + containerFormat_;
      }
    }

    codecContext_ = avcodec_alloc_context3(codec_);
    if (!codecContext_) return "Failed to allocate FFmpeg encoder context";

    codecContext_->bit_rate = bitrate_;
    codecContext_->sample_rate = outputSampleRate_;
    av_channel_layout_default(&codecContext_->ch_layout, outputChannels_);
    codecContext_->sample_fmt = SelectPreferredSampleFormat(codecContext_, codec_);
    codecContext_->time_base = AVRational{1, codecContext_->sample_rate > 0 ? codecContext_->sample_rate : outputSampleRate_};
    codecContext_->thread_count = 1;
    codecContext_->thread_type = 0;
    if (formatContext_ && formatContext_->oformat && (formatContext_->oformat->flags & AVFMT_GLOBALHEADER)) {
      codecContext_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }

    int result = avcodec_open2(codecContext_, codec_, nullptr);
    if (result < 0) {
      CloseInternal();
      return "Failed to open FFmpeg encoder: " + FfAudioAvErrorToString(result);
    }

    frame_ = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (!frame_ || !packet_) {
      CloseInternal();
      return "Failed to allocate FFmpeg encoder frame or packet";
    }

    if (formatContext_) {
      stream_ = avformat_new_stream(formatContext_, nullptr);
      if (!stream_) {
        CloseInternal();
        return "Failed to allocate FFmpeg output stream";
      }
      stream_->time_base = codecContext_->time_base;
      result = avcodec_parameters_from_context(stream_->codecpar, codecContext_);
      if (result < 0) {
        CloseInternal();
        return "Failed to copy FFmpeg encoder parameters to output stream: " + FfAudioAvErrorToString(result);
      }

      constexpr int kAvioBufferSize = 4096;
      uint8_t* avioBuffer = static_cast<uint8_t*>(av_malloc(static_cast<size_t>(kAvioBufferSize)));
      if (!avioBuffer) {
        CloseInternal();
        return "Failed to allocate FFmpeg output AVIO buffer";
      }
      avioContext_ = avio_alloc_context(
        avioBuffer,
        kAvioBufferSize,
        1,
        this,
        nullptr,
        &MediaStreamEncoderState::WritePacketTrampoline,
        &MediaStreamEncoderState::SeekTrampoline
      );
      if (!avioContext_) {
        av_free(avioBuffer);
        CloseInternal();
        return "Failed to allocate FFmpeg output AVIO context";
      }
      avioContext_->seekable = AVIO_SEEKABLE_NORMAL;
      formatContext_->pb = avioContext_;
      formatContext_->flags |= AVFMT_FLAG_CUSTOM_IO;

      result = avformat_write_header(formatContext_, nullptr);
      if (result < 0) {
        CloseInternal();
        return "Failed to write FFmpeg output header: " + FfAudioAvErrorToString(result);
      }
      headerWritten_ = true;
    }

    frame_->sample_rate = codecContext_->sample_rate;
    av_channel_layout_copy(&frame_->ch_layout, &codecContext_->ch_layout);
    frame_->format = codecContext_->sample_fmt;
    frame_->nb_samples = codecContext_->frame_size > 0
      ? codecContext_->frame_size
      : std::max(1, (codecContext_->sample_rate * 20) / 1000);

    av_channel_layout_default(&resamplerSrcLayout_, inputChannels_);
    av_channel_layout_copy(&resamplerDstLayout_, &codecContext_->ch_layout);
    if (
      swr_alloc_set_opts2(
        &resampler_,
        &resamplerDstLayout_,
        codecContext_->sample_fmt,
        codecContext_->sample_rate,
        &resamplerSrcLayout_,
        AV_SAMPLE_FMT_S16,
        inputSampleRate_,
        0,
        nullptr
      ) < 0 || !resampler_
    ) {
      CloseInternal();
      return "Failed to allocate FFmpeg encoder resampler";
    }

    result = swr_init(resampler_);
    if (result < 0) {
      CloseInternal();
      return "Failed to initialize FFmpeg encoder resampler: " + FfAudioAvErrorToString(result);
    }

    return "";
  }

  int WritePacket(const uint8_t* buffer, int bufferSize) {
    if (!buffer || bufferSize <= 0) return 0;

    size_t offset = outputPosition_;
    size_t remaining = static_cast<size_t>(bufferSize);
    const uint8_t* cursor = buffer;

    if (offset < outputLogicalSize_) {
      const size_t overwriteBytes = std::min(remaining, outputLogicalSize_ - offset);
      RecordPatch(offset, cursor, overwriteBytes);
      offset += overwriteBytes;
      cursor += overwriteBytes;
      remaining -= overwriteBytes;
    }

    if (remaining > 0) {
      if (offset != outputLogicalSize_) return AVERROR(EIO);
      queues_.AppendOutput(cursor, remaining);
      outputLogicalSize_ += remaining;
      offset += remaining;
    }

    outputPosition_ = offset;
    return bufferSize;
  }

  int64_t Seek(int64_t offset, int whence) {
    if (whence == AVSEEK_SIZE) return static_cast<int64_t>(outputLogicalSize_);

    const int normalizedWhence = whence & ~AVSEEK_FORCE;
    int64_t nextPosition = 0;
    if (normalizedWhence == SEEK_SET) {
      nextPosition = offset;
    } else if (normalizedWhence == SEEK_CUR) {
      nextPosition = static_cast<int64_t>(outputPosition_) + offset;
    } else if (normalizedWhence == SEEK_END) {
      nextPosition = static_cast<int64_t>(outputLogicalSize_) + offset;
    } else {
      return AVERROR(EINVAL);
    }

    if (nextPosition < 0) return AVERROR(EINVAL);
    outputPosition_ = static_cast<size_t>(nextPosition);
    return nextPosition;
  }

  bool WaitPopInputBytes(size_t requiredBytes, uint8_t* dst, size_t capacity, size_t* drained, bool* reachedEof, std::string* error) {
    if (!drained || !reachedEof || !error) return false;
    *drained = 0;
    *reachedEof = false;
    error->clear();
    if (requiredBytes == 0) return true;
    return queues_.TryPopInputAtLeast(
      requiredBytes,
      dst,
      capacity,
      drained,
      reachedEof,
      error,
      "Native FFmpeg encoder context is closed"
    );
  }

  size_t InputBytesPerFrame() const {
    return static_cast<size_t>(sizeof(int16_t) * inputChannels_);
  }

  int OutputFrameSamples() const {
    if (!codecContext_) return 0;
    return codecContext_->frame_size > 0
      ? codecContext_->frame_size
      : std::max(1, (codecContext_->sample_rate * 20) / 1000);
  }

  int OutputBytesForSamples(int sampleCount) const {
    if (!codecContext_ || sampleCount <= 0) return 0;
    return av_samples_get_buffer_size(nullptr, outputChannels_, sampleCount, codecContext_->sample_fmt, 1);
  }

  void RecordPatch(size_t offset, const uint8_t* data, size_t length) {
    if (!data || !length) return;
    if (!outputPatches_.empty()) {
      OutputPatch& last = outputPatches_.back();
      if (last.offset + last.data.size() == offset) {
        last.data.insert(last.data.end(), data, data + length);
        return;
      }
    }
    OutputPatch patch;
    patch.offset = offset;
    patch.data.assign(data, data + length);
    outputPatches_.push_back(std::move(patch));
  }

  bool SupportsSmallLastFrame() const {
    return codec_ && (codec_->capabilities & AV_CODEC_CAP_SMALL_LAST_FRAME);
  }

  int FlushEncoderPackets() {
    bool producedOutput = false;
    while (true) {
      const int receiveResult = avcodec_receive_packet(codecContext_, packet_);
      if (receiveResult == AVERROR(EAGAIN) || receiveResult == AVERROR_EOF) {
        if (receiveResult == AVERROR_EOF) encodeEof_ = true;
        break;
      }
      if (receiveResult < 0) return receiveResult;

      if (packet_->size > 0) {
        if (formatContext_ && stream_) {
          av_packet_rescale_ts(packet_, codecContext_->time_base, stream_->time_base);
          packet_->stream_index = stream_->index;
          const int writeResult = av_interleaved_write_frame(formatContext_, packet_);
          if (writeResult < 0) {
            av_packet_unref(packet_);
            return writeResult;
          }
        } else {
          queues_.AppendOutput(packet_->data, static_cast<size_t>(packet_->size));
        }
        producedOutput = true;
      }
      av_packet_unref(packet_);
    }
    return producedOutput ? 1 : 0;
  }

  int SendFrameFromBuffer(const uint8_t* data, int frameCount) {
    if (!codecContext_ || !frame_ || !data || frameCount <= 0) return 0;

    const int fillResult = av_samples_fill_arrays(
      frame_->data,
      frame_->linesize,
      const_cast<uint8_t*>(data),
      outputChannels_,
      frameCount,
      codecContext_->sample_fmt,
      1
    );
    if (fillResult < 0) return fillResult;

    frame_->nb_samples = frameCount;
    frame_->format = codecContext_->sample_fmt;
    frame_->sample_rate = codecContext_->sample_rate;
    frame_->pts = nextPts_;
    nextPts_ += frameCount;

    const int sendResult = avcodec_send_frame(codecContext_, frame_);
    if (sendResult < 0) return sendResult;
    return FlushEncoderPackets();
  }

  bool EnsurePendingConvertedFrame(std::string* error) {
    if (!error) return false;
    error->clear();
    const int frameBytes = OutputBytesForSamples(OutputFrameSamples());
    if (frameBytes <= 0) {
      *error = "FFmpeg encoder output frame sizing failed";
      return false;
    }
    if (pendingConvertedFrame_.size() != static_cast<size_t>(frameBytes)) {
      pendingConvertedFrame_.assign(static_cast<size_t>(frameBytes), 0);
    }
    return true;
  }

  size_t RequiredInputBytesForPendingFrame() const {
    if (!resampler_ || !codecContext_) return 0;
    const int frameSamples = OutputFrameSamples();
    const int missingSamples = std::max(0, frameSamples - pendingConvertedSamples_);
    if (missingSamples <= 0) return 0;

    const int64_t delayedInputSamples = swr_get_delay(resampler_, inputSampleRate_);
    const int64_t delayedOutputSamples = av_rescale_rnd(
      delayedInputSamples,
      outputSampleRate_,
      inputSampleRate_,
      AV_ROUND_DOWN
    );
    if (delayedOutputSamples >= missingSamples) return 0;

    const int64_t totalInputSamples = av_rescale_rnd(
      missingSamples,
      inputSampleRate_,
      outputSampleRate_,
      AV_ROUND_UP
    );
    const int64_t neededInputSamples = std::max<int64_t>(1, totalInputSamples - delayedInputSamples);
    return static_cast<size_t>(neededInputSamples) * InputBytesPerFrame();
  }

  bool ConvertIntoPendingFrame(const uint8_t* sourceData, int sourceFrames, bool* madeProgress, std::string* error) {
    if (!madeProgress || !error) return false;
    error->clear();
    *madeProgress = false;
    if (!resampler_ || !codecContext_) {
      *error = "FFmpeg encoder resampler not initialized";
      return false;
    }
    if (!EnsurePendingConvertedFrame(error)) return false;

    const int frameSamples = OutputFrameSamples();
    const int remainingSamples = std::max(0, frameSamples - pendingConvertedSamples_);
    if (remainingSamples <= 0) {
      *madeProgress = true;
      return true;
    }

    const int offsetBytes = OutputBytesForSamples(pendingConvertedSamples_);
    if (offsetBytes < 0) {
      *error = "FFmpeg encoder pending frame offset sizing failed";
      return false;
    }

    uint8_t* convertedData[AV_NUM_DATA_POINTERS] = {nullptr};
    [[maybe_unused]] int convertedLinesize = 0;
    const int fillResult = av_samples_fill_arrays(
      convertedData,
      &convertedLinesize,
      pendingConvertedFrame_.data() + static_cast<size_t>(offsetBytes),
      outputChannels_,
      remainingSamples,
      codecContext_->sample_fmt,
      1
    );
    if (fillResult < 0) {
      *error = "FFmpeg encoder pending frame layout setup failed: " + FfAudioAvErrorToString(fillResult);
      return false;
    }
    const uint8_t* sourcePlanes[1] = {sourceData};
    const int convertedFrames = swr_convert(
      resampler_,
      convertedData,
      remainingSamples,
      sourceData ? sourcePlanes : nullptr,
      sourceFrames
    );
    if (convertedFrames < 0) {
      *error = "FFmpeg encoder resample failed: " + FfAudioAvErrorToString(convertedFrames);
      return false;
    }
    if (convertedFrames > 0) pendingConvertedSamples_ += convertedFrames;
    *madeProgress = convertedFrames > 0 || sourceFrames > 0;
    return true;
  }

  bool SendPendingFrame(bool allowPartialLastFrame, std::string* error) {
    if (!error) return false;
    error->clear();
    if (pendingConvertedSamples_ <= 0) return true;

    const int frameSamples = OutputFrameSamples();
    const int pendingBytes = OutputBytesForSamples(pendingConvertedSamples_);
    if (pendingBytes <= 0) {
      *error = "FFmpeg encoder pending frame sizing failed";
      return false;
    }

    int flushResult = 0;
    if (pendingConvertedSamples_ >= frameSamples) {
      flushResult = SendFrameFromBuffer(pendingConvertedFrame_.data(), frameSamples);
    } else if (!allowPartialLastFrame) {
      return true;
    } else if (SupportsSmallLastFrame()) {
      flushResult = SendFrameFromBuffer(pendingConvertedFrame_.data(), pendingConvertedSamples_);
    } else {
      const int frameBytes = OutputBytesForSamples(frameSamples);
      if (frameBytes <= 0) {
        *error = "FFmpeg encoder final frame sizing failed";
        return false;
      }
      scratchFrame_.assign(static_cast<size_t>(frameBytes), 0);
      std::memcpy(scratchFrame_.data(), pendingConvertedFrame_.data(), static_cast<size_t>(pendingBytes));
      flushResult = SendFrameFromBuffer(scratchFrame_.data(), frameSamples);
    }
    if (flushResult < 0) {
      *error = "FFmpeg encoder frame send failed: " + FfAudioAvErrorToString(flushResult);
      return false;
    }

    pendingConvertedSamples_ = 0;
    return true;
  }

  bool FinalizeEncoder(std::string* error) {
    error->clear();

    while (!encodeEof_) {
      bool madeProgress = false;
      if (!ConvertIntoPendingFrame(nullptr, 0, &madeProgress, error)) return false;

      if (pendingConvertedSamples_ >= OutputFrameSamples()) {
        if (!SendPendingFrame(false, error)) return false;
        if (queues_.OutputSize() > 0) return true;
        continue;
      }

      if (!madeProgress) break;
    }

    if (pendingConvertedSamples_ > 0) {
      if (!SendPendingFrame(true, error)) return false;
      if (queues_.OutputSize() > 0) return true;
    }

    if (!flushPacketSent_) {
      const int sendResult = avcodec_send_frame(codecContext_, nullptr);
      if (sendResult < 0 && sendResult != AVERROR_EOF && sendResult != AVERROR(EAGAIN)) {
        *error = "FFmpeg encoder flush failed: " + FfAudioAvErrorToString(sendResult);
        return false;
      }
      flushPacketSent_ = true;
    }

    const int flushResult = FlushEncoderPackets();
    if (flushResult < 0) {
      *error = "FFmpeg encoder packet flush failed: " + FfAudioAvErrorToString(flushResult);
      return false;
    }

    if (encodeEof_ && formatContext_ && headerWritten_ && !trailerWritten_) {
      const int trailerResult = av_write_trailer(formatContext_);
      if (trailerResult < 0) {
        *error = "FFmpeg output trailer flush failed: " + FfAudioAvErrorToString(trailerResult);
        return false;
      }
      trailerWritten_ = true;
    }

    return true;
  }

  bool ProduceEncodedBytes(std::string* error) {
    error->clear();
    while (queues_.OutputSize() == 0 && !encodeEof_) {
      const int flushResult = FlushEncoderPackets();
      if (flushResult < 0) {
        *error = "FFmpeg encoder packet receive failed: " + FfAudioAvErrorToString(flushResult);
        return false;
      }
      if (queues_.OutputSize() > 0 || encodeEof_) break;

      if (inputDrained_) {
        if (!FinalizeEncoder(error)) return false;
        continue;
      }

      if (pendingConvertedSamples_ >= OutputFrameSamples()) {
        if (!SendPendingFrame(false, error)) return false;
        continue;
      }

      const size_t requiredBytes = RequiredInputBytesForPendingFrame();
      if (requiredBytes == 0) {
        bool madeProgress = false;
        if (!ConvertIntoPendingFrame(nullptr, 0, &madeProgress, error)) return false;
        if (!madeProgress && queues_.IsInputClosed()) inputDrained_ = true;
        continue;
      }

      if (queues_.InputSize() < requiredBytes && !queues_.IsInputClosed()) {
        return true;
      }

      if (inputScratch_.size() < requiredBytes) {
        inputScratch_.resize(requiredBytes);
      }
      size_t chunkBytes = 0;
      bool reachedEof = false;
      if (!WaitPopInputBytes(requiredBytes, inputScratch_.data(), inputScratch_.size(), &chunkBytes, &reachedEof, error)) return false;
      if (reachedEof) {
        inputDrained_ = true;
      }
      if (chunkBytes == 0) continue;

      const size_t inputFrameBytes = InputBytesPerFrame();
      const size_t alignedBytes = inputFrameBytes > 0 ? (chunkBytes - (chunkBytes % inputFrameBytes)) : 0;
      if (alignedBytes == 0) continue;

      bool madeProgress = false;
      if (!ConvertIntoPendingFrame(inputScratch_.data(), static_cast<int>(alignedBytes / inputFrameBytes), &madeProgress, error)) {
        return false;
      }
    }
    return true;
  }

  void CloseInternal() {
    if (formatContext_ && headerWritten_ && !trailerWritten_) {
      av_write_trailer(formatContext_);
      trailerWritten_ = true;
    }
    if (packet_) {
      av_packet_free(&packet_);
      packet_ = nullptr;
    }
    if (frame_) {
      av_frame_free(&frame_);
      frame_ = nullptr;
    }
    if (codecContext_) {
      avcodec_free_context(&codecContext_);
      codecContext_ = nullptr;
    }
    if (avioContext_) {
      av_freep(&avioContext_->buffer);
      avio_context_free(&avioContext_);
      avioContext_ = nullptr;
    }
    if (formatContext_) {
      avformat_free_context(formatContext_);
      formatContext_ = nullptr;
      stream_ = nullptr;
    }
    if (resampler_) {
      swr_free(&resampler_);
    }

    av_channel_layout_uninit(&resamplerSrcLayout_);
    av_channel_layout_uninit(&resamplerDstLayout_);
    codec_ = nullptr;
    flushPacketSent_ = false;
    inputDrained_ = false;
    encodeEof_ = false;
    headerWritten_ = false;
    trailerWritten_ = false;
    pendingConvertedSamples_ = 0;
    inputScratch_.clear();
  }

  std::string codecName_;
  std::string containerFormat_;
  int inputSampleRate_ = kDefaultSampleRate;
  int inputChannels_ = kDefaultChannels;
  int outputSampleRate_ = kDefaultSampleRate;
  int outputChannels_ = kDefaultChannels;
  int bitrate_ = kDefaultBitrate;
  size_t inputQueueLimitBytes_ = kDefaultInputQueueLimitBytes;

  NativeByteQueues queues_;

  std::mutex ffmpegMutex_;
  std::string openError_;

  const AVCodec* codec_ = nullptr;
  AVCodecContext* codecContext_ = nullptr;
  AVFormatContext* formatContext_ = nullptr;
  AVIOContext* avioContext_ = nullptr;
  AVStream* stream_ = nullptr;
  AVFrame* frame_ = nullptr;
  AVPacket* packet_ = nullptr;
  SwrContext* resampler_ = nullptr;
  AVChannelLayout resamplerSrcLayout_{};
  AVChannelLayout resamplerDstLayout_{};

  std::vector<uint8_t> pendingConvertedFrame_;
  std::vector<OutputPatch> outputPatches_;
  std::vector<uint8_t> inputScratch_;
  size_t outputPosition_ = 0;
  size_t outputLogicalSize_ = 0;
  std::vector<uint8_t> scratchFrame_;
  int pendingConvertedSamples_ = 0;
  int64_t nextPts_ = 0;
  bool flushPacketSent_ = false;
  bool inputDrained_ = false;
  bool encodeEof_ = false;
  bool headerWritten_ = false;
  bool trailerWritten_ = false;
};

class MediaStreamWrap : public Napi::ObjectWrap<MediaStreamWrap> {
public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "MediaStream",
      {
        InstanceMethod("readFrom", &MediaStreamWrap::ReadFromValue),
        InstanceMethod("writeInto", &MediaStreamWrap::WriteIntoValue),
        InstanceMethod("takeOutputPatches", &MediaStreamWrap::TakeOutputPatches),
        InstanceMethod("closeInput", &MediaStreamWrap::CloseInput),
        InstanceMethod("getSourceInfo", &MediaStreamWrap::GetSourceInfo),
        InstanceMethod("close", &MediaStreamWrap::Close),
      }
    );
  }

  explicit MediaStreamWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<MediaStreamWrap>(info) {
    const Napi::Env env = info.Env();
    Napi::Object options = info.Length() > 0 && info[0].IsObject() ? info[0].As<Napi::Object>() : Napi::Object::New(env);
    const std::string mode = FfAudioReadStringOption(options, "mode", "decode");
    if (mode == "encode") {
      encoderState_ = std::make_shared<MediaStreamEncoderState>(options);
      return;
    }
    if (mode == "decode" || mode.empty()) {
      decoderState_ = std::make_shared<MediaStreamDecoderState>(options);
      return;
    }
    Napi::TypeError::New(env, "MediaStream mode must be decode or encode").ThrowAsJavaScriptException();
  }

  ~MediaStreamWrap() override {
    if (decoderState_) decoderState_->Close();
    if (encoderState_) encoderState_->Close();
  }

private:
  Napi::Value ReadFromValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "Source buffer is required").ThrowAsJavaScriptException();
      return env.Null();
    }

    size_t written = 0;
    std::string error;
    const auto source = info[0].As<Napi::Buffer<uint8_t>>();
    size_t offset = 0;
    size_t length = source.Length();
    if (info.Length() > 1 && info[1].IsNumber()) {
      const double rawOffset = info[1].As<Napi::Number>().DoubleValue();
      if (std::isfinite(rawOffset) && rawOffset > 0) {
        offset = std::min(source.Length(), static_cast<size_t>(rawOffset));
        length = source.Length() - offset;
      }
    }
    if (info.Length() > 2 && info[2].IsNumber()) {
      const double rawLength = info[2].As<Napi::Number>().DoubleValue();
      if (std::isfinite(rawLength) && rawLength >= 0) {
        length = std::min(length, static_cast<size_t>(rawLength));
      }
    }
    if (decoderState_) {
      if (!decoderState_->ReadFrom(source.Data() + offset, length, &written, &error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Null();
      }
      return Napi::Number::New(env, static_cast<double>(written));
    }

    if (encoderState_) {
      if (!encoderState_->ReadFrom(source.Data() + offset, length, &written, &error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Null();
      }
      return Napi::Number::New(env, static_cast<double>(written));
    }

    Napi::Error::New(env, "Native FFmpeg media stream context is not initialized").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value WriteIntoValue(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "Target buffer is required").ThrowAsJavaScriptException();
      return env.Null();
    }

    size_t bytesRead = 0;
    std::string error;
    const auto target = info[0].As<Napi::Buffer<uint8_t>>();
    size_t offset = 0;
    size_t length = target.Length();
    if (info.Length() > 1 && info[1].IsNumber()) {
      const double rawOffset = info[1].As<Napi::Number>().DoubleValue();
      if (std::isfinite(rawOffset) && rawOffset > 0) {
        offset = std::min(target.Length(), static_cast<size_t>(rawOffset));
        length = target.Length() - offset;
      }
    }
    if (info.Length() > 2 && info[2].IsNumber()) {
      const double rawLength = info[2].As<Napi::Number>().DoubleValue();
      if (std::isfinite(rawLength) && rawLength >= 0) {
        length = std::min(length, static_cast<size_t>(rawLength));
      }
    }
    if (decoderState_) {
      if (!decoderState_->WriteInto(target.Data() + offset, length, &bytesRead, &error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Null();
      }
      return Napi::Number::New(env, static_cast<double>(bytesRead));
    }

    if (encoderState_) {
      if (!encoderState_->WriteInto(target.Data() + offset, length, &bytesRead, &error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Null();
      }
      return Napi::Number::New(env, static_cast<double>(bytesRead));
    }

    Napi::Error::New(env, "Native FFmpeg media stream context is not initialized").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Value CloseInput(const Napi::CallbackInfo& info) {
    if (decoderState_) {
      std::shared_ptr<MediaStreamDecoderState> state = decoderState_;
      state->CloseInput();
    }
    if (encoderState_) {
      std::shared_ptr<MediaStreamEncoderState> state = encoderState_;
      state->CloseInput();
    }
    return info.Env().Undefined();
  }

  Napi::Value GetSourceInfo(const Napi::CallbackInfo& info) {
    if (!decoderState_) return info.Env().Null();
    std::shared_ptr<MediaStreamDecoderState> state = decoderState_;
    return state->BuildSourceInfo(info.Env());
  }

  Napi::Value TakeOutputPatches(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    Napi::Array out = Napi::Array::New(env);
    if (!encoderState_) return out;

    std::shared_ptr<MediaStreamEncoderState> state = encoderState_;
    const auto patches = state->TakeOutputPatches();
    uint32_t index = 0;
    for (const auto& patch : patches) {
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("offset", Napi::Number::New(env, static_cast<double>(patch.offset)));
      entry.Set("data", Napi::Buffer<uint8_t>::Copy(env, patch.data.data(), patch.data.size()));
      out.Set(index++, entry);
    }
    return out;
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    if (decoderState_) {
      std::shared_ptr<MediaStreamDecoderState> state = decoderState_;
      state->Close();
    }
    if (encoderState_) {
      std::shared_ptr<MediaStreamEncoderState> state = encoderState_;
      state->Close();
    }
    return info.Env().Undefined();
  }

  std::shared_ptr<MediaStreamDecoderState> decoderState_;
  std::shared_ptr<MediaStreamEncoderState> encoderState_;
};

} // namespace

Napi::Function InitMediaStream(Napi::Env env) {
  return MediaStreamWrap::Define(env);
}
