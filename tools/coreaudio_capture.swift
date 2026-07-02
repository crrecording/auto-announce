import AudioToolbox
import CoreAudio
import Darwin
import Foundation

struct DeviceInfo {
  let index: Int
  let id: AudioDeviceID
  let uid: String
  let name: String
  let inputChannels: UInt32
}

final class CaptureContext {
  var audioUnit: AudioUnit?
  let writerQueue = DispatchQueue(label: "auto-announce.coreaudio.writer")
}

func check(_ status: OSStatus, _ message: String) {
  if status != noErr {
    FileHandle.standardError.write("\(message): \(status)\n".data(using: .utf8)!)
    exit(1)
  }
}

func audioObjectString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
  if status != noErr { return nil }
  return value as String
}

func inputChannelCount(_ deviceID: AudioDeviceID) -> UInt32 {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let sizeStatus = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size)
  if sizeStatus != noErr || size == 0 { return 0 }

  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }

  let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, raw)
  if status != noErr { return 0 }

  let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return buffers.reduce(UInt32(0)) { $0 + $1.mNumberChannels }
}

func allInputDevices() -> [DeviceInfo] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "Could not read CoreAudio device list size")

  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  var ids = Array(repeating: AudioDeviceID(0), count: count)
  check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids), "Could not read CoreAudio device list")

  var devices: [DeviceInfo] = []
  for id in ids {
    let channels = inputChannelCount(id)
    guard let uid = audioObjectString(id, kAudioDevicePropertyDeviceUID),
          let name = audioObjectString(id, kAudioObjectPropertyName) else {
      continue
    }
    devices.append(DeviceInfo(index: devices.count, id: id, uid: uid, name: name, inputChannels: channels))
  }
  return devices
}

func defaultInputDeviceID() -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var deviceID = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
  if status != noErr || deviceID == 0 { return nil }
  return deviceID
}

func jsonEscape(_ value: String) -> String {
  var escaped = ""
  for scalar in value.unicodeScalars {
    switch scalar {
    case "\"": escaped += "\\\""
    case "\\": escaped += "\\\\"
    case "\n": escaped += "\\n"
    case "\r": escaped += "\\r"
    case "\t": escaped += "\\t"
    default:
      if scalar.value < 0x20 {
        escaped += String(format: "\\u%04x", scalar.value)
      } else {
        escaped.unicodeScalars.append(scalar)
      }
    }
  }
  return escaped
}

func printDeviceListJSON() {
  let devices = allInputDevices()
  let items = devices.map { device in
    "{\"index\":\(device.index),\"uid\":\"\(jsonEscape(device.uid))\",\"name\":\"\(jsonEscape(device.name))\",\"inputChannels\":\(device.inputChannels)}"
  }
  print("[\(items.joined(separator: ","))]")
}

func selectedDevice(from args: [String]) -> AudioDeviceID {
  let devices = allInputDevices()
  if let uidIndex = args.firstIndex(of: "--device-uid"), uidIndex + 1 < args.count {
    let uid = args[uidIndex + 1]
    if let device = devices.first(where: { $0.uid == uid }) { return device.id }
    FileHandle.standardError.write("CoreAudio device UID not found: \(uid)\n".data(using: .utf8)!)
    exit(1)
  }
  if let indexIndex = args.firstIndex(of: "--device-index"), indexIndex + 1 < args.count {
    let index = Int(args[indexIndex + 1]) ?? -1
    if let device = devices.first(where: { $0.index == index }) { return device.id }
    FileHandle.standardError.write("CoreAudio device index not found: \(index)\n".data(using: .utf8)!)
    exit(1)
  }
  if let defaultID = defaultInputDeviceID() { return defaultID }
  FileHandle.standardError.write("No default CoreAudio input device found\n".data(using: .utf8)!)
  exit(1)
}

func writeAll(_ fd: Int32, _ pointer: UnsafeRawPointer, _ byteCount: Int) {
  var offset = 0
  while offset < byteCount {
    let written = write(fd, pointer.advanced(by: offset), byteCount - offset)
    if written <= 0 { return }
    offset += written
  }
}

let inputCallback: AURenderCallback = { refCon, ioActionFlags, inTimeStamp, _, inNumberFrames, _ in
  let context = Unmanaged<CaptureContext>.fromOpaque(refCon).takeUnretainedValue()
  guard let unit = context.audioUnit else { return noErr }

  let byteCount = Int(inNumberFrames) * 2
  let data = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 2)
  defer { data.deallocate() }

  var bufferList = AudioBufferList(
    mNumberBuffers: 1,
    mBuffers: AudioBuffer(
      mNumberChannels: 1,
      mDataByteSize: UInt32(byteCount),
      mData: data
    )
  )

  let status = AudioUnitRender(unit, ioActionFlags, inTimeStamp, 1, inNumberFrames, &bufferList)
  if status == noErr, let rendered = bufferList.mBuffers.mData {
    let data = Data(bytes: rendered, count: Int(bufferList.mBuffers.mDataByteSize))
    context.writerQueue.async {
      data.withUnsafeBytes { raw in
        if let base = raw.baseAddress {
          writeAll(STDOUT_FILENO, base, raw.count)
        }
      }
    }
  }
  return noErr
}

func startCapture(deviceID: AudioDeviceID) {
  var description = AudioComponentDescription(
    componentType: kAudioUnitType_Output,
    componentSubType: kAudioUnitSubType_HALOutput,
    componentManufacturer: kAudioUnitManufacturer_Apple,
    componentFlags: 0,
    componentFlagsMask: 0
  )
  guard let component = AudioComponentFindNext(nil, &description) else {
    FileHandle.standardError.write("Could not find HAL output AudioUnit\n".data(using: .utf8)!)
    exit(1)
  }

  let context = CaptureContext()
  var maybeUnit: AudioUnit?
  check(AudioComponentInstanceNew(component, &maybeUnit), "Could not create HAL AudioUnit")
  guard let unit = maybeUnit else {
    FileHandle.standardError.write("HAL AudioUnit was nil\n".data(using: .utf8)!)
    exit(1)
  }
  context.audioUnit = unit

  var enableInput: UInt32 = 1
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enableInput, UInt32(MemoryLayout<UInt32>.size)), "Could not enable input")

  var disableOutput: UInt32 = 0
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &disableOutput, UInt32(MemoryLayout<UInt32>.size)), "Could not disable output")

  var selected = deviceID
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &selected, UInt32(MemoryLayout<AudioDeviceID>.size)), "Could not select CoreAudio input device")

  var format = AudioStreamBasicDescription(
    mSampleRate: 48_000,
    mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
    mBytesPerPacket: 2,
    mFramesPerPacket: 1,
    mBytesPerFrame: 2,
    mChannelsPerFrame: 1,
    mBitsPerChannel: 16,
    mReserved: 0
  )
  check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "Could not set capture stream format")

  var callback = AURenderCallbackStruct(
    inputProc: inputCallback,
    inputProcRefCon: Unmanaged.passRetained(context).toOpaque()
  )
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "Could not set input callback")

  check(AudioUnitInitialize(unit), "Could not initialize HAL AudioUnit")
  check(AudioOutputUnitStart(unit), "Could not start HAL AudioUnit")
  RunLoop.current.run()
}

let args = CommandLine.arguments
if args.contains("--list-json") {
  printDeviceListJSON()
  exit(0)
}

let deviceID = selectedDevice(from: args)
startCapture(deviceID: deviceID)
