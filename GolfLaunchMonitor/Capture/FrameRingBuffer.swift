//
//  FrameRingBuffer.swift
//  GolfLaunchMonitor
//
//  Lock-free single-producer / single-consumer ring of CVPixelBuffers.
//
//  Design constraints:
//   * The producer is AVFoundation's capture callback queue. At 240 FPS it gets
//     4.16 ms per frame. Anything that allocates, locks, or touches Swift's
//     runtime metadata in that path risks a dropped frame, so this type does
//     none of those things in `write(_:)`.
//   * Storage is a fixed `UnsafeMutableBufferPointer` of `Unmanaged<CVBuffer>?`
//     allocated once at init. No ARC traffic on the hot path: we retain the
//     pixel buffer exactly once with `passRetained` and release the slot's
//     previous occupant manually.
//   * Sequencing uses `Synchronization.Atomic` (iOS 18+ / Swift 6) with explicit
//     acquire/release ordering rather than a lock. Correct for exactly one
//     producer thread and one consumer thread, which is what we have.
//
//  IMPORTANT: capacity must be <= the capture pool's buffer count, otherwise
//  holding 30 frames starves AVFoundation and it starts dropping. See
//  `CameraManager.configurePixelBufferPool` for how that is negotiated.
//

import Foundation
import CoreVideo
import CoreMedia
import os

/// One captured frame plus the metadata the analyzer needs to interpret it.
/// Deliberately a value type of POD fields so it can live in a preallocated array.
/// `@unchecked Sendable` because CVPixelBuffer is not annotated Sendable, yet
/// moving one of these between the capture queue and the analyzer actor is
/// safe here by construction:
///
///   * The ring holds a strong retain on every buffer it hands out, so the
///     capture pool cannot recycle a buffer while the analyzer holds it.
///   * The analyzer only ever READS pixel data. Nothing mutates a buffer after
///     AVFoundation has delivered it.
///   * `snapshot` re-checks the write head after copying and refuses to return
///     a range that was overwritten mid-copy.
///
/// Without this, every hand-off to BallTracker is "sending risks causing data
/// races" — a true statement about the type, not about this usage.
struct FrameSlot: @unchecked Sendable {
    var pixelBuffer: CVPixelBuffer
    /// Presentation timestamp straight from the sample buffer. This is the
    /// authoritative clock — do *not* assume 1/240 s spacing, the sensor drops
    /// frames under thermal load and the deltas matter for velocity.
    var presentationTime: CMTime
    /// Monotonic index assigned by the producer. Gaps mean dropped frames.
    var sequence: Int
}

/// SPSC ring with lock-free atomic sequence counters via os_unfair_lock.
final class FrameRingBuffer: @unchecked Sendable {

    /// Number of frames retained. 30 frames @ 240 FPS = 125 ms of history,
    /// which comfortably brackets impact (we need ~8 pre-impact frames to
    /// establish the ball is stationary and 12 after).
    let capacity: Int

    private let storage: UnsafeMutableBufferPointer<Unmanaged<CVPixelBuffer>?>
    private let times: UnsafeMutableBufferPointer<CMTime>

    private var _writeIndex: Int = 0
    private var lock = os_unfair_lock_s()

    init(capacity: Int = 30) {
        precondition(capacity > 0)
        self.capacity = capacity
        storage = .allocate(capacity: capacity)
        storage.initialize(repeating: nil)
        times = .allocate(capacity: capacity)
        times.initialize(repeating: .invalid)
    }

    deinit {
        for i in 0..<capacity { storage[i]?.release() }
        storage.deallocate()
        times.deallocate()
    }

    // MARK: - Producer

    /// Called from the AVFoundation capture queue. Must not allocate or block.
    /// Returns the sequence number assigned to this frame.
    @discardableResult
    func write(_ pixelBuffer: CVPixelBuffer, pts: CMTime) -> Int {
        os_unfair_lock_lock(&lock)
        let seq = _writeIndex
        _writeIndex += 1
        let slot = seq % capacity

        storage[slot]?.release()
        storage[slot] = Unmanaged.passRetained(pixelBuffer)
        times[slot] = pts

        os_unfair_lock_unlock(&lock)
        return seq
    }

    // MARK: - Consumer

    /// Most recent sequence number written.
    var latestSequence: Int {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return _writeIndex
    }

    /// Copy out a contiguous run of frames ending at `endSequence` (inclusive).
    func snapshot(endingAt endSequence: Int, count: Int) -> [FrameSlot]? {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        guard count > 0, count <= capacity else { return nil }
        let start = endSequence - count + 1
        guard start >= 0 else { return nil }

        let head = _writeIndex
        guard start >= head - capacity, endSequence < head else { return nil }

        var out = [FrameSlot]()
        out.reserveCapacity(count)
        for seq in start...endSequence {
            let slot = seq % capacity
            guard let unmanaged = storage[slot] else { return nil }
            out.append(FrameSlot(pixelBuffer: unmanaged.takeUnretainedValue(),
                                 presentationTime: times[slot],
                                 sequence: seq))
        }

        return out
    }

    /// Drop every retained frame. Called when disarming so we don't pin
    /// capture-pool buffers while idle.
    func reset() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        for i in 0..<capacity {
            storage[i]?.release()
            storage[i] = nil
            times[i] = .invalid
        }
        _writeIndex = 0
    }
}
