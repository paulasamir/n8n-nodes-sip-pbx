{
  "targets": [
    {
      "target_name": "native",
      "sources": [
        "native/addon.cc",
        "native/codecs/register.cc",
        "native/codecs/g722.cc",
        "native/codecs/g729.cc",
        "native/codecs/opus.cc",
        "native/streams/register.cc",
        "native/streams/ffmpeg.cc",
        "vendor/libg722/g722_encode.c",
        "vendor/libg722/g722_decode.c",
        "<!@(node scripts/list-opus-sources.js)",
        "vendor/bcg729/src/adaptativeCodebookSearch.c",
        "vendor/bcg729/src/codebooks.c",
        "vendor/bcg729/src/computeAdaptativeCodebookGain.c",
        "vendor/bcg729/src/computeLP.c",
        "vendor/bcg729/src/computeWeightedSpeech.c",
        "vendor/bcg729/src/decodeAdaptativeCodeVector.c",
        "vendor/bcg729/src/decodeFixedCodeVector.c",
        "vendor/bcg729/src/decodeGains.c",
        "vendor/bcg729/src/decodeLSP.c",
        "vendor/bcg729/src/decoder.c",
        "vendor/bcg729/src/encoder.c",
        "vendor/bcg729/src/findOpenLoopPitchDelay.c",
        "vendor/bcg729/src/fixedCodebookSearch.c",
        "vendor/bcg729/src/gainQuantization.c",
        "vendor/bcg729/src/interpolateqLSP.c",
        "vendor/bcg729/src/LP2LSPConversion.c",
        "vendor/bcg729/src/LPSynthesisFilter.c",
        "vendor/bcg729/src/LSPQuantization.c",
        "vendor/bcg729/src/postFilter.c",
        "vendor/bcg729/src/postProcessing.c",
        "vendor/bcg729/src/preProcessing.c",
        "vendor/bcg729/src/qLSP2LP.c",
        "vendor/bcg729/src/utils.c",
        "vendor/bcg729/src/cng.c",
        "vendor/bcg729/src/dtx.c",
        "vendor/bcg729/src/vad.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!@(node scripts/ffmpeg-system-flags.js include-dirs)",
        "vendor/libopus",
        "vendor/libopus/include",
        "vendor/libopus/celt",
        "vendor/libopus/silk",
        "vendor/libopus/silk/float",
        "vendor/libopus/src",
        "vendor/libg722",
        "vendor/bcg729/include",
        "vendor/bcg729/src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "libraries": [
        "<!@(node scripts/ffmpeg-system-flags.js library-files)"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "BCG729_STATIC",
        "HAVE_CONFIG_H",
        "USE_ALLOCA=1"
      ],
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15"
            }
          }
        ],
        [
          "OS==\"win\"",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
