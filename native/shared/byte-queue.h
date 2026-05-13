#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

class ByteQueue {
public:
  explicit ByteQueue(size_t capacity = 0) {
    Reserve(capacity);
  }

  size_t Size() const {
    return size_;
  }

  size_t size() const {
    return Size();
  }

  bool Empty() const {
    return size_ == 0;
  }

  bool empty() const {
    return Empty();
  }

  void Clear() {
    head_ = 0;
    size_ = 0;
  }

  void clear() {
    Clear();
  }

  size_t Append(const uint8_t* data, size_t length) {
    if (!data || length == 0) {
      return 0;
    }
    EnsureCapacity(size_ + length);
    if (storage_.empty()) {
      return 0;
    }

    const size_t tail = TailIndex();
    const size_t first = std::min(length, storage_.size() - tail);
    std::memcpy(storage_.data() + tail, data, first);
    if (length > first) {
      std::memcpy(storage_.data(), data + first, length - first);
    }
    size_ += length;
    return length;
  }

  size_t Drain(uint8_t* dst, size_t capacity) {
    if (!dst || capacity == 0 || size_ == 0) {
      return 0;
    }
    const size_t toCopy = std::min(capacity, size_);
    if (storage_.empty()) {
      return 0;
    }
    const size_t first = std::min(toCopy, storage_.size() - head_);
    std::memcpy(dst, storage_.data() + head_, first);
    if (toCopy > first) {
      std::memcpy(dst + first, storage_.data(), toCopy - first);
    }
    head_ = (head_ + toCopy) % storage_.size();
    size_ -= toCopy;
    if (size_ == 0) {
      head_ = 0;
    }
    return toCopy;
  }

  size_t Discard(size_t count) {
    const size_t toDrop = std::min(count, size_);
    if (toDrop == 0) {
      return 0;
    }
    if (storage_.empty()) {
      head_ = 0;
      size_ = 0;
      return 0;
    }
    head_ = (head_ + toDrop) % storage_.size();
    size_ -= toDrop;
    if (size_ == 0) {
      head_ = 0;
    }
    return toDrop;
  }

  size_t CopyPrefix(uint8_t* dst, size_t count) const {
    if (!dst || count == 0 || size_ == 0) {
      return 0;
    }
    const size_t toCopy = std::min(count, size_);
    if (storage_.empty()) {
      return 0;
    }
    const size_t first = std::min(toCopy, storage_.size() - head_);
    std::memcpy(dst, storage_.data() + head_, first);
    if (toCopy > first) {
      std::memcpy(dst + first, storage_.data(), toCopy - first);
    }
    return toCopy;
  }

  uint32_t PeekU32LE() const {
    if (size_ == 0 || storage_.empty()) {
      return 0;
    }
    const size_t limit = std::min<size_t>(4, size_);
    uint32_t value = 0;
    for (size_t index = 0; index < limit; index += 1) {
      value |= static_cast<uint32_t>(storage_[(head_ + index) % storage_.size()]) << (index * 8);
    }
    return value;
  }

private:
  void Reserve(size_t capacity) {
    if (capacity <= storage_.size()) {
      return;
    }

    const size_t currentCapacity = storage_.size();
    const size_t newCapacity = currentCapacity > 0
      ? std::max(capacity, currentCapacity * 2)
      : capacity;
    std::vector<uint8_t> next(newCapacity);
    CopyPrefix(next.data(), size_);
    storage_.swap(next);
    head_ = 0;
  }

  void EnsureCapacity(size_t desiredCapacity) {
    if (desiredCapacity <= storage_.size()) {
      return;
    }

    const size_t currentCapacity = storage_.size();
    const size_t newCapacity = currentCapacity > 0
      ? std::max(desiredCapacity, currentCapacity * 2)
      : desiredCapacity;
    std::vector<uint8_t> next(newCapacity);
    CopyPrefix(next.data(), size_);
    storage_.swap(next);
    head_ = 0;
  }

  size_t TailIndex() const {
    return storage_.empty() ? 0 : (head_ + size_) % storage_.size();
  }

  std::vector<uint8_t> storage_;
  size_t head_ = 0;
  size_t size_ = 0;
};
