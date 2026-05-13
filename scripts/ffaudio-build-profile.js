#!/usr/bin/env node
"use strict";

const PROFILE = Object.freeze({
  inputFormats: Object.freeze([
    "mp3",
    "wav",
    "flac",
    "ogg",
    "opus",
    "aac",
    "wma",
    "amr",
  ]),
  optionalAudioContainerInputFormats: Object.freeze([
    "m4a",
    "mov",
    "webm",
  ]),
  outputFormats: Object.freeze([
    "wav",
    "mp3",
    "ogg",
    "opus",
    "aac",
  ]),
  ffmpeg: Object.freeze({
    demuxers: Object.freeze([
      "aac",
      "amr",
      "amrnb",
      "amrwb",
      "asf",
      "flac",
      "matroska",
      "mov",
      "mp3",
      "ogg",
      "wav",
    ]),
    muxers: Object.freeze([
      "adts",
      "mp3",
      "ogg",
      "opus",
      "wav",
    ]),
    decoders: Object.freeze([
      "aac",
      "amrnb",
      "amrwb",
      "flac",
      "mp3",
      "mp3float",
      "opus",
      "pcm_f32le",
      "pcm_s16le",
      "pcm_s24le",
      "pcm_s32le",
      "pcm_u8",
      "vorbis",
      "wmav1",
      "wmav2",
      "wmavoice",
    ]),
    encoders: Object.freeze([
      "aac",
      "libmp3lame",
      "libopus",
      "pcm_f32le",
      "pcm_s16le",
      "pcm_s24le",
      "pcm_s32le",
    ]),
    parsers: Object.freeze([
      "aac",
      "amr",
      "flac",
      "mpegaudio",
      "opus",
      "vorbis",
    ]),
  }),
});

function toConfigureFlags(profile) {
  return [
    "--disable-autodetect",
    "--disable-debug",
    "--disable-avdevice",
    "--disable-avfilter",
    "--disable-doc",
    "--disable-everything",
    "--disable-htmlpages",
    "--disable-manpages",
    "--disable-network",
    "--disable-podpages",
    "--disable-programs",
    "--disable-swscale",
    "--disable-txtpages",
    "--enable-avcodec",
    "--enable-avformat",
    "--enable-avutil",
    "--enable-gpl",
    "--enable-libmp3lame",
    "--enable-libopus",
    "--enable-static",
    "--enable-swresample",
    "--pkg-config-flags=--static",
    "--disable-shared",
    ...profile.ffmpeg.demuxers.map((value) => `--enable-demuxer=${value}`),
    ...profile.ffmpeg.muxers.map((value) => `--enable-muxer=${value}`),
    ...profile.ffmpeg.decoders.map((value) => `--enable-decoder=${value}`),
    ...profile.ffmpeg.encoders.map((value) => `--enable-encoder=${value}`),
    ...profile.ffmpeg.parsers.map((value) => `--enable-parser=${value}`),
  ];
}

if (require.main === module) {
  const json = process.argv.includes("--json");
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...PROFILE, configureFlags: toConfigureFlags(PROFILE) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${toConfigureFlags(PROFILE).join(" ")}\n`);
  }
}

module.exports = {
  PROFILE,
  toConfigureFlags,
};
