export type AudioCue =
  | 'slice-0'
  | 'slice-1'
  | 'slice-2'
  | 'slice-3'
  | 'bomb'
  | 'combo'
  | 'countdown'
  | 'round-end'
  | 'victory';

/**
 * Small, fully local Web Audio sound bank. The buffers are synthesized once so
 * the game never needs a network request and overlapping slices remain cheap.
 */
export class AudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private _volume = 0.72;
  private _muted = false;

  get unlocked(): boolean {
    return this.context?.state === 'running';
  }

  get volume(): number {
    return this._volume;
  }

  get muted(): boolean {
    return this._muted;
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer(0.34);
      this.applyGain();
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    // A zero-volume pulse commits the audio route on Safari/Chrome without an
    // audible startup click.
    const pulse = this.context.createOscillator();
    const gain = this.context.createGain();
    gain.gain.value = 0;
    pulse.connect(gain).connect(this.master!);
    pulse.start();
    pulse.stop(this.context.currentTime + 0.01);
  }

  setVolume(value: number): void {
    this._volume = Math.min(1, Math.max(0, value));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    this.applyGain();
  }

  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  play(cue: AudioCue, pan = 0): void {
    if (!this.context || !this.master || this.context.state !== 'running' || this._muted) {
      return;
    }

    if (cue.startsWith('slice-')) {
      this.playSlice(Number(cue.at(-1) ?? 0), pan);
      return;
    }

    switch (cue) {
      case 'bomb':
        this.playBomb(pan);
        break;
      case 'combo':
        this.playChord([660, 880, 1100], 0.11, 'sine', pan, 0.18);
        break;
      case 'countdown':
        this.playTone(620, 0.08, 'square', pan, 0.12);
        break;
      case 'round-end':
        this.playChord([523, 392], 0.28, 'triangle', pan, 0.2);
        break;
      case 'victory':
        this.playVictory();
        break;
      default:
        break;
    }
  }

  private applyGain(): void {
    if (!this.master || !this.context) return;
    const target = this._muted ? 0 : this._volume;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.015);
  }

  private createNoiseBuffer(durationSeconds: number): AudioBuffer {
    const context = this.context!;
    const length = Math.ceil(context.sampleRate * durationSeconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let previous = 0;

    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.64 + white * 0.36;
      channel[index] = previous;
    }

    return buffer;
  }

  private routeWithPan(node: AudioNode, pan: number): void {
    const panner = this.context!.createStereoPanner();
    panner.pan.value = Math.min(1, Math.max(-1, pan));
    node.connect(panner).connect(this.master!);
  }

  private playSlice(variant: number, pan: number): void {
    const context = this.context!;
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = [1.45, 1.8, 2.15, 2.55][variant % 4] ?? 1.8;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime([980, 1280, 1580, 1880][variant % 4] ?? 1280, now);
    filter.Q.value = 1.1;

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.23, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.105);

    source.connect(filter).connect(envelope);
    this.routeWithPan(envelope, pan);
    source.start(now);
    source.stop(now + 0.13);

    this.playTone(170 + variant * 25, 0.055, 'triangle', pan, 0.035);
  }

  private playBomb(pan: number): void {
    const context = this.context!;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(150, now);
    oscillator.frequency.exponentialRampToValueAtTime(42, now + 0.34);
    envelope.gain.setValueAtTime(0.28, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    oscillator.connect(envelope);
    this.routeWithPan(envelope, pan);
    oscillator.start(now);
    oscillator.stop(now + 0.4);

    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 420;
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(0.2, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    noise.connect(lowpass).connect(noiseGain);
    this.routeWithPan(noiseGain, pan);
    noise.start(now);
    noise.stop(now + 0.32);
  }

  private playTone(
    frequency: number,
    duration: number,
    type: OscillatorType,
    pan: number,
    gainValue: number,
    startOffset = 0,
  ): void {
    const context = this.context!;
    const start = context.currentTime + startOffset;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    this.routeWithPan(envelope, pan);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  private playChord(
    frequencies: number[],
    duration: number,
    type: OscillatorType,
    pan: number,
    gainValue: number,
  ): void {
    frequencies.forEach((frequency, index) => {
      this.playTone(frequency, duration, type, pan, gainValue / frequencies.length, index * 0.045);
    });
  }

  private playVictory(): void {
    [523, 659, 784, 1047].forEach((frequency, index) => {
      this.playTone(frequency, 0.34, 'triangle', 0, 0.11, index * 0.12);
    });
  }
}
