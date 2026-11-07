import Foundation
import AVFoundation
import AudioToolbox

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let starts = [0.0, 5.0, 15.0, 20.0, 26.0]
let windows = [5.0, 10.0, 5.0, 6.0, 4.0]
let outputDuration = 30.0
let sampleRate = 22_050.0
let totalFrames = Int(outputDuration * sampleRate)
var samples = [Float](repeating: 0, count: totalFrames)

for index in 0..<starts.count {
    let input = try AVAudioFile(forReading: directory.appendingPathComponent("line-\(index + 1).aiff"))
    guard input.processingFormat.channelCount == 1,
          input.processingFormat.sampleRate == sampleRate else {
        fatalError("Narration clips must be mono at 22050 Hz")
    }
    let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat,
                                  frameCapacity: AVAudioFrameCount(input.length))!
    try input.read(into: buffer)
    let count = Int(buffer.frameLength)
    guard Double(count) / sampleRate <= windows[index] else {
        fatalError("Line \(index + 1) exceeds its visual window")
    }
    let startFrame = Int(starts[index] * sampleRate)
    let source = buffer.floatChannelData![0]
    let fadeFrames = min(220, count / 2)
    for frame in 0..<count {
        let fadeIn = min(1, Float(frame) / Float(fadeFrames))
        let fadeOut = min(1, Float(count - frame - 1) / Float(fadeFrames))
        samples[startFrame + frame] = source[frame] * min(fadeIn, fadeOut)
    }
}

func writeWav(_ name: String, from start: Int, count: Int) throws {
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: sampleRate, channels: 1, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat,
                                  frameCapacity: AVAudioFrameCount(count))!
    buffer.frameLength = AVAudioFrameCount(count)
    let destination = buffer.floatChannelData![0]
    for index in 0..<count { destination[index] = samples[start + index] }
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false
    ]
    let output = try AVAudioFile(forWriting: directory.appendingPathComponent(name),
                                 settings: settings, commonFormat: .pcmFormatFloat32,
                                 interleaved: false)
    try output.write(from: buffer)
}

try writeWav("voiceover-part-1-15s.wav", from: 0, count: Int(15 * sampleRate))
try writeWav("voiceover-part-2-15s.wav", from: Int(15 * sampleRate), count: Int(15 * sampleRate))
try writeWav("voiceover-full-30s.wav", from: 0, count: totalFrames)
