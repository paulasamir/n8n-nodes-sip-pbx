#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <condition_variable>
#include <mutex>
#include <string>

#include <napi.h>

#include "byte-queue.h"

#if defined(__linux__) || defined(__APPLE__)
#include <pthread.h>
#endif

inline void NativeSetThreadName(const std::string& name) {
  if (name.empty()) {
    return;
  }
  std::string normalized = name;
  if (normalized.size() > 15) {
    normalized.resize(15);
  }
#if defined(__linux__)
  pthread_setname_np(pthread_self(), normalized.c_str());
#elif defined(__APPLE__)
  pthread_setname_np(normalized.c_str());
#else
  (void)normalized;
#endif
}

inline bool NativeGetBufferRange(
  const Napi::CallbackInfo& info,
  size_t bufferIndex,
  const char* requiredMessage,
  uint8_t** data,
  size_t* length) {
  if (!data || !length) {
    return false;
  }
  *data = nullptr;
  *length = 0;
  const Napi::Env env = info.Env();
  if (info.Length() <= bufferIndex || !info[bufferIndex].IsBuffer()) {
    Napi::TypeError::New(env, requiredMessage ? requiredMessage : "Buffer is required").ThrowAsJavaScriptException();
    return false;
  }
  const auto buffer = info[bufferIndex].As<Napi::Buffer<uint8_t>>();
  size_t offset = 0;
  size_t rangeLength = buffer.Length();
  const size_t offsetIndex = bufferIndex + 1;
  const size_t lengthIndex = bufferIndex + 2;
  if (info.Length() > offsetIndex && info[offsetIndex].IsNumber()) {
    const double rawOffset = info[offsetIndex].As<Napi::Number>().DoubleValue();
    if (rawOffset > 0) {
      offset = std::min(buffer.Length(), static_cast<size_t>(rawOffset));
      rangeLength = buffer.Length() - offset;
    }
  }
  if (info.Length() > lengthIndex && info[lengthIndex].IsNumber()) {
    const double rawLength = info[lengthIndex].As<Napi::Number>().DoubleValue();
    if (rawLength >= 0) {
      rangeLength = std::min(rangeLength, static_cast<size_t>(rawLength));
    }
  }
  *data = buffer.Data() + offset;
  *length = rangeLength;
  return true;
}

class NativeByteQueues {
public:
  explicit NativeByteQueues(size_t inputQueueLimitBytes)
    : inputQueueLimitBytes_(std::max<size_t>(4096, inputQueueLimitBytes)),
      inputQueue_(std::max<size_t>(4096, inputQueueLimitBytes)),
      outputQueue_(4096) {}

  bool PushInput(
    const uint8_t* data,
    size_t length,
    size_t* written,
    std::string* error,
    const char* requiredMessage,
    const char* closedMessage,
    const char* limitMessage,
    const char* inputClosedMessage = nullptr) {
    return PushInputSegments(
      data,
      length,
      nullptr,
      0,
      written,
      error,
      requiredMessage,
      closedMessage,
      limitMessage,
      inputClosedMessage,
      true
    );
  }

  bool TryPushInput(
    const uint8_t* data,
    size_t length,
    size_t* written,
    std::string* error,
    const char* requiredMessage,
    const char* closedMessage,
    const char* limitMessage,
    const char* inputClosedMessage = nullptr) {
    return PushInputSegments(
      data,
      length,
      nullptr,
      0,
      written,
      error,
      requiredMessage,
      closedMessage,
      limitMessage,
      inputClosedMessage,
      false
    );
  }

  bool PushInputWithLengthPrefix(
    const uint8_t* data,
    size_t length,
    size_t* written,
    std::string* error,
    const char* requiredMessage,
    const char* closedMessage,
    const char* limitMessage,
    const char* inputClosedMessage = nullptr) {
    const uint8_t prefix[4] = {
      static_cast<uint8_t>(length & 0xffu),
      static_cast<uint8_t>((length >> 8) & 0xffu),
      static_cast<uint8_t>((length >> 16) & 0xffu),
      static_cast<uint8_t>((length >> 24) & 0xffu),
    };
    return PushInputSegments(
      prefix,
      sizeof(prefix),
      data,
      length,
      written,
      error,
      requiredMessage,
      closedMessage,
      limitMessage,
      inputClosedMessage,
      true
    );
  }

  bool TryPushInputWithLengthPrefix(
    const uint8_t* data,
    size_t length,
    size_t* written,
    std::string* error,
    const char* requiredMessage,
    const char* closedMessage,
    const char* limitMessage,
    const char* inputClosedMessage = nullptr) {
    const uint8_t prefix[4] = {
      static_cast<uint8_t>(length & 0xffu),
      static_cast<uint8_t>((length >> 8) & 0xffu),
      static_cast<uint8_t>((length >> 16) & 0xffu),
      static_cast<uint8_t>((length >> 24) & 0xffu),
    };
    return PushInputSegments(
      prefix,
      sizeof(prefix),
      data,
      length,
      written,
      error,
      requiredMessage,
      closedMessage,
      limitMessage,
      inputClosedMessage,
      false
    );
  }

  bool TryDrainInput(
    uint8_t* dst,
    size_t capacity,
    size_t* drained,
    bool* reachedEof,
    std::string* error,
    const char* closedMessage) {
    if (!drained || !reachedEof || !error) return false;
    *drained = 0;
    *reachedEof = false;
    error->clear();
    if (!dst && capacity > 0) {
      *error = "Target buffer is required";
      return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) {
      *error = closedMessage ? std::string(closedMessage) : "Stream is closed";
      return false;
    }
    if (inputQueue_.empty()) {
      *reachedEof = inputClosed_;
      return true;
    }

    *drained = inputQueue_.Drain(dst, capacity);
    cond_.notify_all();
    return true;
  }

  bool TryPopInputAtLeast(
    size_t minCount,
    uint8_t* dst,
    size_t capacity,
    size_t* drained,
    bool* reachedEof,
    std::string* error,
    const char* closedMessage) {
    if (!drained || !reachedEof || !error) return false;
    *drained = 0;
    *reachedEof = false;
    error->clear();
    if (!dst && capacity > 0) {
      *error = "Target buffer is required";
      return false;
    }
    if (capacity < minCount) {
      *error = "Target buffer is smaller than requested input";
      return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) {
      *error = closedMessage ? std::string(closedMessage) : "Stream is closed";
      return false;
    }
    if (inputQueue_.size() < minCount) {
      if (inputClosed_) {
        *reachedEof = true;
      }
      return true;
    }

    const size_t toCopy = std::min(capacity, inputQueue_.size());
    const bool finalChunk = inputClosed_ && inputQueue_.size() <= toCopy;
    *drained = inputQueue_.Drain(dst, toCopy);
    *reachedEof = finalChunk;
    cond_.notify_all();
    return true;
  }

  bool IsClosed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return closed_;
  }

  bool IsInputClosed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return inputClosed_;
  }

  size_t InputSize() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return inputQueue_.size();
  }

  size_t OutputSize() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return outputQueue_.size();
  }

  size_t CopyInputPrefix(uint8_t* dst, size_t count) const {
    if (!dst || count == 0) {
      return 0;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    const size_t toCopy = std::min(count, inputQueue_.size());
    inputQueue_.CopyPrefix(dst, toCopy);
    return toCopy;
  }

  uint32_t PeekInputU32LE() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return inputQueue_.PeekU32LE();
  }

  size_t DiscardInput(size_t count) {
    std::lock_guard<std::mutex> lock(mutex_);
    const size_t dropped = inputQueue_.Discard(count);
    cond_.notify_all();
    return dropped;
  }

  void AppendOutput(const uint8_t* data, size_t length) {
    if (!data || !length) return;
    std::lock_guard<std::mutex> lock(mutex_);
    outputQueue_.Append(data, length);
    cond_.notify_all();
  }

  size_t DrainOutput(uint8_t* dst, size_t count) {
    std::lock_guard<std::mutex> lock(mutex_);
    const size_t drained = outputQueue_.Drain(dst, count);
    cond_.notify_all();
    return drained;
  }

  void CloseInput() {
    std::lock_guard<std::mutex> lock(mutex_);
    inputClosed_ = true;
    cond_.notify_all();
  }

  void Close() {
    std::lock_guard<std::mutex> lock(mutex_);
    closed_ = true;
    inputClosed_ = true;
    inputQueue_.clear();
    outputQueue_.clear();
    cond_.notify_all();
  }

private:
  bool PushInputSegments(
    const uint8_t* firstData,
    size_t firstLength,
    const uint8_t* secondData,
    size_t secondLength,
    size_t* written,
    std::string* error,
    const char* requiredMessage,
    const char* closedMessage,
    const char* limitMessage,
    const char* inputClosedMessage = nullptr,
    bool waitForSpace = true) {
    if (!written || !error) return false;
    *written = 0;
    error->clear();
    if ((!firstData && firstLength > 0) || (!secondData && secondLength > 0)) {
      *error = requiredMessage ? std::string(requiredMessage) : "Source buffer is required";
      return false;
    }
    const size_t totalLength = firstLength + secondLength;
    if (totalLength == 0) return true;
    if (totalLength > inputQueueLimitBytes_) {
      *error = limitMessage ? std::string(limitMessage) : "Input chunk exceeds queue capacity";
      return false;
    }

    std::unique_lock<std::mutex> lock(mutex_);
    if (inputQueue_.size() + totalLength > inputQueueLimitBytes_) {
      if (!waitForSpace) {
        return true;
      }
      while (!closed_ && !inputClosed_ && (inputQueue_.size() + totalLength > inputQueueLimitBytes_)) {
        cond_.wait(lock);
      }
    }
    if (closed_) {
      *error = closedMessage ? std::string(closedMessage) : "Stream is closed";
      return false;
    }
    if (inputClosed_) {
      *error = inputClosedMessage ? std::string(inputClosedMessage) : "Stream input already closed";
      return false;
    }

    if (firstLength > 0) {
      inputQueue_.Append(firstData, firstLength);
    }
    if (secondLength > 0) {
      inputQueue_.Append(secondData, secondLength);
    }
    *written = totalLength;
    cond_.notify_all();
    return true;
  }

  mutable std::mutex mutex_;
  std::condition_variable cond_;
  size_t inputQueueLimitBytes_;
  ByteQueue inputQueue_;
  ByteQueue outputQueue_;
  bool inputClosed_ = false;
  bool closed_ = false;
};
