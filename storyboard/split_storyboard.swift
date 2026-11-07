import Foundation
import CoreGraphics
import ImageIO
import AppKit

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      image.width == 1536, image.height == 1024 else {
    fatalError("Expected a 1536×1024 six-panel storyboard")
}

let panelWidth = 768
let panelHeight = 341
let panels = [
    CGRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
    CGRect(x: 768, y: 0, width: panelWidth, height: panelHeight),
    CGRect(x: 0, y: 341, width: panelWidth, height: panelHeight),
    CGRect(x: 768, y: 341, width: panelWidth, height: panelHeight),
    CGRect(x: 0, y: 683, width: panelWidth, height: panelHeight),
    CGRect(x: 768, y: 683, width: panelWidth, height: panelHeight)
]

func savePart(_ indices: [Int], as name: String) {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(data: nil, width: panelWidth, height: panelHeight * 3,
                            bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .none
    for (position, index) in indices.enumerated() {
        let crop = image.cropping(to: panels[index])!
        context.draw(crop, in: CGRect(x: 0, y: (2 - position) * panelHeight,
                                     width: panelWidth, height: panelHeight))
    }
    let result = context.makeImage()!
    let bitmap = NSBitmapImageRep(cgImage: result)
    let data = bitmap.representation(using: .png, properties: [:])!
    try! data.write(to: outputDirectory.appendingPathComponent(name))
}

savePart([0, 1, 2], as: "storyboard-part-1-15s.png")
savePart([3, 4, 5], as: "storyboard-part-2-15s.png")
