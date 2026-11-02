// CyraxoHealth Kinematic Analysis Backtester
// Build 2026.04.01 - Automated Diagnostics Node Script

const assert = require('assert');

// 1. Core Kinematic Processor Code (replicated from posture-app/app.js)
class KinematicEngine {
    constructor(targetReps = 10) {
        this.targetReps = targetReps;
        this.reset();
    }

    reset() {
        this.isCalibrating = true;
        this.calibrationSamples = [];
        this.calibratedMin = null;
        this.calibratedMax = null;
        this.baselineSpan = null;
        this.lowThreshold = null;
        this.highThreshold = null;
        this.minAngle = null;
        this.maxAngle = null;
        this.stage = 'down';
        this.reps = 0;
        this.isActive = false;
    }

    processSample(angle) {
        if (this.isCalibrating) {
            this.calibrationSamples.push(angle);
            // Simulate 7-second calibration completion at ~30fps (~210 samples)
            // or when we call completeCalibration manually
            return { type: 'calibration', progress: this.calibrationSamples.length };
        }

        if (this.isActive) {
            if (angle > this.maxAngle) this.maxAngle = angle;
            if (angle < this.minAngle) this.minAngle = angle;

            let repCompleted = false;
            if (angle > this.highThreshold) {
                this.stage = 'up';
            }
            if (angle < this.lowThreshold && this.stage === 'up') {
                this.stage = 'down';
                this.reps += 1;
                repCompleted = true;
            }

            return {
                type: 'tracking',
                reps: this.reps,
                stage: this.stage,
                repCompleted,
                romPercent: this.calculateROMPercent()
            };
        }

        return { type: 'inactive' };
    }

    completeCalibration() {
        if (this.calibrationSamples.length === 0) return;
        const samples = this.calibrationSamples.slice().sort((a, b) => a - b);
        const trim = Math.max(0, Math.floor(samples.length * 0.08));
        const stableSamples = samples.slice(trim, samples.length - trim || samples.length);
        const min = Math.min(...stableSamples);
        const max = Math.max(...stableSamples);
        const span = Math.max(1, max - min);

        this.calibratedMin = min;
        this.calibratedMax = max;
        this.baselineSpan = span;
        this.lowThreshold = min + (span * 0.32);
        this.highThreshold = min + (span * 0.76);
        this.minAngle = max;
        this.maxAngle = min;
        this.stage = 'down';
        this.isCalibrating = false;
        this.isActive = true;
    }

    calculateROMPercent() {
        if (this.baselineSpan === null || this.minAngle === null || this.maxAngle === null) return 0;
        const currentSpan = this.maxAngle - this.minAngle;
        return Math.min(100, Math.round((currentSpan / this.baselineSpan) * 100));
    }
}

// 2. Test Suite Execution
console.log('====================================================');
console.log('🤖 Running CyraxoHealth Kinematic Backtesting Suite');
console.log('====================================================\n');

// --- TEST 1: Ideal Sinusoidal Range of Motion (80° to 170°) ---
console.log('Running Test 1: Ideal Sinusoidal ROM (80° - 170°)');
const test1Engine = new KinematicEngine(5);

// Calibrate with 100 samples oscillating around 80° - 170°
for (let i = 0; i < 100; i++) {
    const angle = 125 + 45 * Math.sin((i / 100) * 2 * Math.PI);
    test1Engine.processSample(angle);
}
test1Engine.completeCalibration();

console.log(` -> Calibration successful.`);
console.log(` -> Span: ${test1Engine.baselineSpan.toFixed(2)}° (Target: ~90°)`);
console.log(` -> Low Threshold: ${test1Engine.lowThreshold.toFixed(2)}° (Target: ~108.8°)`);
console.log(` -> High Threshold: ${test1Engine.highThreshold.toFixed(2)}° (Target: ~148.4°)`);

// Check basic thresholds sanity
assert.ok(test1Engine.baselineSpan >= 80 && test1Engine.baselineSpan <= 92);
assert.ok(test1Engine.lowThreshold > 100 && test1Engine.lowThreshold < 112);
assert.ok(test1Engine.highThreshold > 140 && test1Engine.highThreshold < 152);

// Simulate 5 full perfect repetitions
let repCount = 0;
const signalPeriod = 30; // 30 frames per rep
for (let rep = 0; rep < 5; rep++) {
    for (let frame = 0; frame < signalPeriod; frame++) {
        // Oscillation from 80 to 170 and back
        const angle = 125 + 45 * Math.sin((frame / signalPeriod) * 2 * Math.PI);
        const res = test1Engine.processSample(angle);
        if (res.repCompleted) {
            repCount++;
            console.log(`    [Rep Completed] Total reps: ${res.reps}, ROM: ${res.romPercent}%`);
        }
    }
}

console.log(` -> Final reps: ${test1Engine.reps} (Expected: 5)`);
console.log(` -> ROM achieved: ${test1Engine.calculateROMPercent()}% (Expected: >= 95%)\n`);
assert.strictEqual(test1Engine.reps, 5);
assert.ok(test1Engine.calculateROMPercent() >= 95);


// --- TEST 2: Low Amplitude / Noisy Sub-Threshold Jiggle Rejection ---
console.log('Running Test 2: Dynamic Hysteresis Noise Filter (100° - 125°)');
const test2Engine = new KinematicEngine(5);

// Calibrate with small but valid ROM (100° - 125°)
for (let i = 0; i < 60; i++) {
    const angle = 112.5 + 12.5 * Math.sin((i / 60) * 2 * Math.PI);
    test2Engine.processSample(angle);
}
test2Engine.completeCalibration();

console.log(` -> Calibration successful.`);
console.log(` -> Span: ${test2Engine.baselineSpan.toFixed(2)}° (Target: ~25°)`);
console.log(` -> Low Threshold: ${test2Engine.lowThreshold.toFixed(2)}°`);
console.log(` -> High Threshold: ${test2Engine.highThreshold.toFixed(2)}°`);

// Feed minor noisy fluctuations (108° - 116°) that do not cross the high threshold
console.log(' -> Feeding sub-threshold micro-movements...');
let noisyReps = 0;
for (let i = 0; i < 200; i++) {
    const angle = 112 + 4 * Math.sin(i);
    const res = test2Engine.processSample(angle);
    if (res.repCompleted) noisyReps++;
}
console.log(` -> Noise-induced reps detected: ${noisyReps} (Expected: 0)`);
assert.strictEqual(noisyReps, 0);
assert.strictEqual(test2Engine.reps, 0);
console.log(' -> Sub-threshold jiggles successfully filtered out!\n');


// --- TEST 3: Baseline Drift (Calibrating FHP Side Profile Ear-Shoulder Offset) ---
console.log('Running Test 3: Side-Profile FHP Deviation & Baseline Drift Calibration');

const calculateCervicalScore = (ear, shoulder) => {
    const cX = Math.abs(ear.x - shoulder.x);
    return Math.max(0, Math.round(100 - (cX * 450)));
};

// Baseline: Perfect ear-shoulder stack (cX = 0.01)
const earBaseline = { x: 0.51, y: 0.2 };
const shoulderBaseline = { x: 0.50, y: 0.4 };
const baselineScore = calculateCervicalScore(earBaseline, shoulderBaseline);
console.log(` -> Baseline stacked stack FHP score: ${baselineScore}/100`);
assert.ok(baselineScore >= 95);

// Severe FHP: Progressive forward lean drift (cX shifts from 0.01 to 0.10)
console.log(' -> Simulating progressive forward head posture drift...');
const scores = [];
for (let i = 0; i <= 6; i++) {
    const driftX = 0.01 + (i * 0.015); // cX increases
    const earDrifting = { x: 0.50 + driftX, y: 0.2 };
    const score = calculateCervicalScore(earDrifting, shoulderBaseline);
    scores.push(score);
    console.log(`    Drift step ${i}: offset: ${driftX.toFixed(3)}, Cervical Score: ${score}/100`);
}

console.log(` -> Final drifted cervical score: ${scores[scores.length - 1]}/100`);
assert.ok(scores[scores.length - 1] < 60);
console.log(' -> FHP score scaling is highly responsive and properly tuned!\n');

console.log('====================================================');
console.log('🎉 ALL KINEMATIC BACKTESTS COMPLETED SUCCESSFULLY!');
console.log('====================================================');
