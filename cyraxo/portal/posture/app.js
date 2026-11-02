// CyraxoHealth Clinical Portal - Posture Module Logic
// Build 2026.04.01 - Hardened Clinical Data Engine

import { auth, db, onAuthStateChanged, collection, addDoc, query, getDocs, doc, setDoc, getDoc } from '../firebase-config.js';

// --- SECURITY ENGINE: Clinical Sanitization & Scrubbing ---
const Security = {
    MAX_PAYLOAD: 5000,
    sanitize: (str) => {
        if (typeof str !== 'string') return str;
        return str.replace(/[<>\\"'/{}]/g, '').trim().substring(0, Security.MAX_PAYLOAD);
    },
    phiScrub: (str) => {
        const phiPatterns = [/\b\d{3}-\d{2}-\d{4}\b/g, /\b\d{10,}\b/g];
        return str.replace(phiPatterns, '[REDACTED]');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // 1. Element Binding
    const canvasElement = document.getElementById('output-canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const fileInput = document.getElementById('image-upload');
    const patientNameInput = document.getElementById('report-patient-name');
    const reportNotesInput = document.getElementById('report-notes');
    const clinicDisplayName = document.getElementById('clinic-display-name');
    const motionEngineStatus = document.getElementById('motion-engine-status');
    const lastScanStatus = document.getElementById('last-scan-status');
    const profileLabel = document.getElementById('profile-label');
    const reportPreview = document.getElementById('report-preview');
    const clinicLogoUpload = document.getElementById('clinic-logo-upload');
    const clinicLogoPreview = document.getElementById('clinic-logo-preview');
    const settingsClinicName = document.getElementById('settings-clinic-name');
    const settingsClinicContact = document.getElementById('settings-clinic-contact');
    const settingsClinicAddress = document.getElementById('settings-clinic-address');

    let currentClinicId = null;
    let lastScanData = null;
    let scanHistory = [];
    let clinicPatients = [];
    let activePatient = null;
    let selectedClinicPatient = null;
    let patientMotionStream = null;
    let patientPose = null;
    let patientCameraLoop = null;
    let patientRepTracker = null;
    let activeDailySession = null;
    let patientExpandedScheduleDay = null;
    let patientVoiceRecognition = null;
    let patientMotionFacingMode = 'user';
    let patientMotionWideCamera = false;
    const patientVoiceAssistant = {
        enabled: false,
        panelOpen: false,
        listening: false,
        lastCueAt: 0,
        voice: null,
        speechToken: 0
    };
    const routeParams = new URLSearchParams(window.location.search);
    const forcedPatientMode = routeParams.get('role') === 'patient';
    const requestedClinicTab = routeParams.get('tab');
    let clinicSettings = {
        name: 'CyraxoHealth Clinic',
        contact: '',
        address: '',
        logo: ''
    };
    let onboardingStep = 1;
    const STORAGE_KEYS = {
        settings: 'cyrax_posture_clinic_settings',
        history: 'cyrax_posture_scan_history',
        patients: 'cyrax_posture_patients',
        patientSession: 'cyrax_patient_session_code'
    };
    const EXERCISE_DB = {
        "Cervical Protraction (FHP)": { title: "Chin Tucks (Cervical Retraction)", desc: "Counters forward head posture by strengthening deep neck flexors.", steps: ["Sit tall with shoulders back.", "Tuck chin straight back (creating a 'double chin').", "Hold for 5 seconds.", "Repeat 10 times."] },
        "Increased Thoracic Kyphosis": { title: "Wall Angels", desc: "Opens the chest and strengthens upper back retractors.", steps: ["Stand with back against a wall.", "Keep elbows and backs of hands touching the wall.", "Slide arms up and down like a snow angel.", "Perform 12 slow reps."] },
        "Anterior Pelvic Tilt Detected": { title: "Hip Flexor Stretch", desc: "Reduces pelvic rotation by lengthening tight psoas muscles.", steps: ["Kneel on one knee, other foot flat.", "Tuck tailbone under until you feel a pull in the hip.", "Lean forward slightly while maintaining hip tuck.", "Hold 30 seconds per side."] },
        "Shoulder Girdle Asymmetry": { title: "Scapular Setting Drill", desc: "Improves shoulder blade control and left-right symmetry.", steps: ["Stand tall with both arms relaxed.", "Draw shoulder blades gently back and down.", "Hold for 4 seconds without shrugging.", "Repeat 12 controlled reps."] },
        "Pelvic Girdle Obliquity": { title: "Side Plank Hip Holds", desc: "Builds lateral trunk and pelvic stability.", steps: ["Lie on your side with knees bent.", "Lift hips until shoulders, hips, and knees line up.", "Hold steady while breathing.", "Complete 3 holds of 15-25 seconds per side."] }
    };
    const PROTOCOL_LIBRARY = {
        knee: [
            { title: 'Heel Slides', detail: 'Restore knee flexion with slow controlled heel slides.', sets: '3 sets of 12', cue: 'Stop before sharp pain and keep the heel aligned with the hip.' },
            { title: 'Quad Sets', detail: 'Activate quadriceps without joint shear.', sets: '3 sets of 10 holds', cue: 'Press the knee down, hold 5 seconds, then fully relax.' },
            { title: 'Straight Leg Raise', detail: 'Build early extension control.', sets: '2 sets of 10', cue: 'Keep the knee locked and lift only to the height of the opposite knee.' }
        ],
        shoulder: [
            { title: 'Pendulum Circles', detail: 'Reduce guarding and improve shoulder comfort.', sets: '2 minutes each direction', cue: 'Let the arm hang heavy and move from the trunk.' },
            { title: 'Wall Walks', detail: 'Rebuild overhead range of motion gradually.', sets: '3 sets of 8', cue: 'Walk fingers upward until a gentle stretch, then hold 3 seconds.' },
            { title: 'Scapular Retractions', detail: 'Improve shoulder blade control.', sets: '3 sets of 12', cue: 'Pull shoulder blades down and back without shrugging.' }
        ],
        ankle: [
            { title: 'Ankle Alphabet', detail: 'Restore multi-direction mobility.', sets: '2 rounds', cue: 'Draw each letter slowly with the big toe.' },
            { title: 'Calf Raises', detail: 'Rebuild plantarflexion strength.', sets: '3 sets of 10', cue: 'Rise evenly through both feet and lower slowly.' },
            { title: 'Band Dorsiflexion', detail: 'Strengthen ankle control into dorsiflexion.', sets: '2 sets of 12', cue: 'Pull toes toward the shin without rotating the leg.' }
        ],
        back: [
            { title: 'Cat-Cow Mobility', detail: 'Improve lumbar and thoracic segmental motion.', sets: '2 sets of 10', cue: 'Move slowly and keep the range comfortable.' },
            { title: 'Bird Dog', detail: 'Train trunk stability and hip control.', sets: '3 sets of 8 each side', cue: 'Keep hips level and pause at full reach.' },
            { title: 'Glute Bridge', detail: 'Improve posterior-chain support.', sets: '3 sets of 10', cue: 'Drive through heels and avoid arching the low back.' }
        ],
        neck: [
            { title: 'Chin Tucks', detail: 'Strengthen deep neck flexors.', sets: '3 sets of 10', cue: 'Move straight back, not down.' },
            { title: 'Upper Trap Stretch', detail: 'Reduce neck guarding.', sets: '3 holds of 20 seconds', cue: 'Keep the opposite shoulder relaxed.' },
            { title: 'Wall Angels', detail: 'Improve cervical-thoracic posture.', sets: '2 sets of 8', cue: 'Keep ribs down and move only through comfortable range.' }
        ],
        hip: [
            { title: 'Hip Flexor Stretch', detail: 'Restore hip extension mobility.', sets: '3 holds of 25 seconds each side', cue: 'Tuck the pelvis before leaning forward.' },
            { title: 'Clamshells', detail: 'Strengthen hip abductors and rotators.', sets: '3 sets of 12 each side', cue: 'Keep feet together and avoid rolling the pelvis backward.' },
            { title: 'Supported Squat to Chair', detail: 'Build controlled hip and knee loading.', sets: '2 sets of 10', cue: 'Sit back to the chair with knees tracking over toes.' }
        ],
        general: [
            { title: 'Controlled Mobility Flow', detail: 'Restore comfortable range through the affected area.', sets: '10 minutes daily', cue: 'Use smooth motion and avoid pain spikes.' },
            { title: 'Isometric Holds', detail: 'Build tolerance without excessive joint motion.', sets: '3 sets of 8 holds', cue: 'Hold 5 seconds at moderate effort.' },
            { title: 'Walking or Light Cycle', detail: 'Maintain circulation and recovery capacity.', sets: '10-20 minutes', cue: 'Stay below symptom escalation.' }
        ]
    };
    const EXERCISE_STEPS = {
        'Heel Slides': ['Lie on your back with both legs straight.', 'Slowly slide the heel of the recovering leg toward your body.', 'Pause at the deepest comfortable bend for 2 seconds.', 'Slide the heel back out until the knee is straight again.'],
        'Quad Sets': ['Sit or lie with the recovering leg straight.', 'Tighten the thigh muscle by gently pressing the back of the knee downward.', 'Hold the contraction without lifting the heel.', 'Relax fully before the next hold.'],
        'Straight Leg Raise': ['Lie on your back with the opposite knee bent.', 'Tighten the thigh of the recovering leg until the knee is straight.', 'Lift the leg to the height of the bent knee.', 'Lower slowly and reset before the next rep.'],
        'Pendulum Circles': ['Lean forward with the non-working hand supported on a table.', 'Let the recovering arm hang relaxed below the shoulder.', 'Move your trunk gently to create small circles.', 'Keep the shoulder relaxed and avoid active lifting.'],
        'Wall Walks': ['Stand facing a wall with fingertips on the wall.', 'Walk the fingers upward until you feel a gentle stretch.', 'Hold the top position for 3 seconds.', 'Walk the fingers back down with control.'],
        'Scapular Retractions': ['Sit or stand tall with arms relaxed.', 'Draw both shoulder blades gently back and down.', 'Hold without shrugging or arching your back.', 'Release slowly and repeat.'],
        'Ankle Alphabet': ['Sit with the recovering foot lifted slightly off the floor.', 'Use the big toe to draw each letter of the alphabet.', 'Move only from the ankle as much as possible.', 'Keep the motion slow and controlled.'],
        'Calf Raises': ['Stand tall with hands lightly supported.', 'Rise onto the balls of both feet evenly.', 'Pause briefly at the top.', 'Lower slowly until heels touch down.'],
        'Band Dorsiflexion': ['Anchor a band in front of the foot and loop it over the forefoot.', 'Start with toes pointed slightly away.', 'Pull toes toward the shin against the band.', 'Return slowly without letting the foot snap back.'],
        'Cat-Cow Mobility': ['Start on hands and knees with a neutral spine.', 'Round the back upward while tucking the chin gently.', 'Reverse by lowering the belly and lifting the chest.', 'Move slowly through a comfortable range.'],
        'Bird Dog': ['Start on hands and knees with hips level.', 'Reach one arm and the opposite leg away from the body.', 'Pause while keeping the trunk steady.', 'Return with control and alternate sides.'],
        'Glute Bridge': ['Lie on your back with knees bent and feet flat.', 'Brace gently and press through the heels.', 'Lift hips until shoulders, hips, and knees form a line.', 'Lower slowly without arching the low back.'],
        'Chin Tucks': ['Sit tall and look straight ahead.', 'Slide the head straight backward as if making a double chin.', 'Hold without looking down.', 'Relax forward to neutral and repeat.'],
        'Upper Trap Stretch': ['Sit tall and hold the side of the chair with one hand.', 'Tilt the head away from that hand.', 'Stop at a gentle stretch along the side of the neck.', 'Breathe slowly and avoid pulling hard.'],
        'Wall Angels': ['Stand with back near a wall and ribs down.', 'Place elbows and backs of hands toward the wall if comfortable.', 'Slide arms upward while keeping the neck relaxed.', 'Lower slowly and keep motion pain-free.'],
        'Hip Flexor Stretch': ['Kneel with the recovering-side knee down and the other foot forward.', 'Gently tuck the pelvis under before leaning forward.', 'Shift forward until the front of the hip stretches.', 'Hold while breathing without arching the back.'],
        'Clamshells': ['Lie on your side with knees bent and feet together.', 'Keep hips stacked and pelvis still.', 'Lift the top knee while feet stay touching.', 'Lower slowly without rolling backward.'],
        'Supported Squat to Chair': ['Stand in front of a chair with feet hip-width apart.', 'Reach hips back toward the chair.', 'Keep knees tracking over the middle toes.', 'Lightly tap the chair and stand back up.'],
        'Controlled Mobility Flow': ['Move slowly through the comfortable range your clinic assigned.', 'Pause before pain or pinching starts.', 'Return to the starting position with control.', 'Keep breathing steady throughout the movement.'],
        'Isometric Holds': ['Set up in the exercise position shown by your clinic plan.', 'Build pressure gradually to moderate effort.', 'Hold steady without shaking or holding your breath.', 'Release slowly and rest between holds.'],
        'Walking or Light Cycle': ['Begin at an easy pace.', 'Keep effort low enough to speak comfortably.', 'Stop if symptoms increase or your form changes.', 'Cool down for 2 minutes before finishing.']
    };

    // 2. Auth Watcher
    onAuthStateChanged(auth, async (user) => {
        if (forcedPatientMode) {
            currentClinicId = null;
            showPatientEntry();
        } else if (!user) {
            currentClinicId = null;
            showPatientEntry();
        } else {
            currentClinicId = user.uid;
            document.getElementById('patient-code-gate').style.display = 'none';
            document.getElementById('patient-dashboard').style.display = 'none';
            document.getElementById('app-mount').style.display = 'flex';
            // Secondary background fetch of clinicSettings from Firestore
            try {
                const clinicDocRef = doc(db, 'clinics', currentClinicId);
                const clinicSnap = await getDoc(clinicDocRef);
                if (clinicSnap.exists()) {
                    const data = clinicSnap.data();
                    if (data.clinicSettings) {
                        clinicSettings = { ...clinicSettings, ...data.clinicSettings };
                        localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(clinicSettings));
                        loadClinicSettings();
                    }
                }
            } catch (err) {
                console.error('Failed to load clinic settings from Firestore:', err);
            }
            if (!clinicSettings.name || clinicSettings.name === 'CyraxoHealth Clinic') {
                clinicSettings.name = user.email || clinicSettings.name;
            }
            updateClinicBranding();
            loadAnonymizedRecords();
            await loadClinicPatients();
            launchClinicDefaultView();
        }
    });

    loadClinicSettings();
    loadLocalHistory();
    updateReportPreview();

    const checkOnboarding = () => {
        const isDone = localStorage.getItem('cyrax_posture_onboarded');
        if (isDone) {
            window.switchTab('summary');
        }
    };

    const launchClinicDefaultView = () => {
        if (requestedClinicTab && document.getElementById(`view-${requestedClinicTab}`)) {
            window.switchTab(requestedClinicTab);
            return;
        }
        checkOnboarding();
    };

    const updatePatientContextNav = () => {
        document.querySelectorAll('.patient-context-nav').forEach((item) => {
            item.classList.toggle('context-ready', Boolean(selectedClinicPatient));
            item.style.display = selectedClinicPatient ? 'flex' : 'none';
        });
    };

    window.switchTab = (id) => {
        if ((id === 'recovery' || id === 'progress') && !selectedClinicPatient) {
            window.switchTab('patients');
            return;
        }
        document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + id).classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const nav = document.getElementById('nav-' + id);
        if(nav) nav.classList.add('active');
        document.getElementById('view-title').textContent = id.charAt(0).toUpperCase() + id.slice(1) + " Dashboard";
        if (id === 'reports') updateReportPreview();
        if (id === 'patients') renderPatientRoster();
        updatePatientContextNav();
    };

    function showPatientEntry() {
        document.getElementById('app-mount').style.display = 'none';
        const savedCode = sessionStorage.getItem(STORAGE_KEYS.patientSession);
        if (savedCode) {
            loginPatientByCode(savedCode, true);
            return;
        }
        document.getElementById('patient-dashboard').style.display = 'none';
        document.getElementById('patient-code-gate').style.display = 'flex';
    }

    // 3. MediaPipe Pose Node
    let pose = null;
    if (typeof Pose !== 'undefined') {
        pose = new Pose({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`
        });
        pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        pose.onResults(onResults);
    }
    if (motionEngineStatus) motionEngineStatus.textContent = pose ? 'Ready' : 'Unavailable';

    // 4. Handle Scan
    if (!pose && lastScanStatus) lastScanStatus.textContent = 'MediaPipe failed to load';

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const statusOverlay = document.getElementById('status-overlay');
            if (!pose) {
                if (statusOverlay) statusOverlay.textContent = 'Motion engine failed to load. Please refresh and try again.';
                return;
            }
            if (statusOverlay) statusOverlay.textContent = 'Processing Clinical Baseline...';
            if (lastScanStatus) lastScanStatus.textContent = 'Processing image';
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const maxDim = 720; // Performance optimization
                    let w = img.width;
                    let h = img.height;
                    const scaleFactor = Math.min(maxDim / w, maxDim / h);
                    
                    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                    canvasElement.width = Math.floor(w * scaleFactor);
                    canvasElement.height = Math.floor(h * scaleFactor);
                    canvasCtx.drawImage(img, 0, 0, canvasElement.width, canvasElement.height);
                    if (pose) pose.send({ image: canvasElement });
                };
                img.onerror = () => {
                    if (statusOverlay) statusOverlay.textContent = 'Image could not be read. Please use a different file.';
                    if (lastScanStatus) lastScanStatus.textContent = 'Image load failed';
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }
    });

    function onResults(results) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

        if (results.poseLandmarks && results.poseLandmarks.length > 24) {
            if (typeof drawConnectors === 'function' && typeof POSE_CONNECTIONS !== 'undefined') {
                drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#2563eb', lineWidth: 4 });
            }
            if (typeof drawLandmarks === 'function') {
                drawLandmarks(canvasCtx, results.poseLandmarks, { color: '#dc2626', lineWidth: 2, radius: 4 });
            }

            const landmarks = results.poseLandmarks;
            const profileType = document.getElementById('profile-type').value;
            const detectedIssues = [];
            let cScore = 100, tScore = 100, pScore = 100;
            
            if (profileType === 'side') {
                const isRightSide = landmarks[12].visibility > landmarks[11].visibility;
                const ear = isRightSide ? landmarks[8] : landmarks[7];
                const shoulder = isRightSide ? landmarks[12] : landmarks[11];
                const hip = isRightSide ? landmarks[24] : landmarks[23];
                const knee = isRightSide ? landmarks[26] : landmarks[25];

                const cX = Math.abs(ear.x - shoulder.x);
                if (cX > 0.04) detectedIssues.push("Cervical Protraction (FHP)");
                cScore = Math.max(0, Math.round(100 - (cX * 450)));
                
                const tX = Math.abs(shoulder.x - hip.x);
                if (tX > 0.05) detectedIssues.push("Increased Thoracic Kyphosis");
                tScore = Math.max(0, Math.round(100 - (tX * 400)));

                const pX = Math.abs(hip.x - knee.x);
                if (pX > 0.04) detectedIssues.push("Anterior Pelvic Tilt Detected");
                pScore = Math.max(0, Math.round(100 - (pX * 400)));
            } else {
                const lShoulder = landmarks[11], rShoulder = landmarks[12];
                const lHip = landmarks[23], rHip = landmarks[24];
                const sTilt = Math.abs(lShoulder.y - rShoulder.y);
                if (sTilt > 0.02) detectedIssues.push("Shoulder Girdle Asymmetry");
                cScore = Math.max(0, Math.round(100 - (sTilt * 800)));
                const pTilt = Math.abs(lHip.y - rHip.y);
                if (pTilt > 0.02) detectedIssues.push("Pelvic Girdle Obliquity");
                pScore = Math.max(0, Math.round(100 - (pTilt * 800)));
            }

            lastScanData = {
                cervical: cScore,
                thoracic: tScore,
                pelvic: pScore,
                overall: Math.round((cScore + tScore + pScore) / 3),
                issues: detectedIssues,
                profileType,
                imageData: canvasElement.toDataURL('image/png'),
                timestamp: new Date().toISOString(),
                cyraxID: 'CX-' + Math.floor(Math.random() * 9000 + 1000)
            };
            persistLocalScan(lastScanData);
            updateUI(lastScanData);
            
            if (onboardingStep < 3) handleOnboardingStep();
        } else {
            const statusOverlay = document.getElementById('status-overlay');
            if (statusOverlay) statusOverlay.textContent = 'No full-body pose detected. Use a clear image with shoulders and hips visible.';
            if (lastScanStatus) lastScanStatus.textContent = 'Pose not detected';
        }
        canvasCtx.restore();
    }

    const handleOnboardingStep = () => {
        if(onboardingStep === 1) {
            onboardingStep = 2;
            document.getElementById('dot-2').classList.add('active');
            document.getElementById('step-title').textContent = "Step 2: Spines & Symmetry";
            document.getElementById('step-desc').textContent = "Please upload a BACK VIEW image to calibrate spinal alignment.";
            document.getElementById('profile-type').value = "back";
            document.getElementById('onboard-action-btn').textContent = "Capture Back Profile";
            document.getElementById('status-overlay').textContent = "Awaiting Back Profile...";
        } else if (onboardingStep === 2) {
            onboardingStep = 3;
            document.getElementById('dot-3').classList.add('active');
            localStorage.setItem('cyrax_posture_onboarded', 'true');
            document.getElementById('onboard-step-content').innerHTML = `
                <div style="font-size: 3rem; margin-bottom: 20px;">✅</div>
                <h2>Clinical Baseline Ready</h2>
                <p style="margin-bottom: 30px;">Multi-profile calibration complete. Syncing with institutional cloud vault.</p>
                <button class="btn btn-primary" style="width: 100%;" onclick="syncAndLaunch()">Launch Dashboard</button>
            `;
        }
    };

    window.syncAndLaunch = async () => {
        await window.syncToCloud();
        window.switchTab('summary');
    };

    function updateUI(m) {
        document.getElementById('metric-cervical').textContent = m.cervical + '%';
        document.getElementById('metric-thoracic').textContent = m.thoracic + '%';
        document.getElementById('metric-pelvic').textContent = m.pelvic + '%';
        document.getElementById('metric-overall').textContent = m.overall + '/100';
        if (lastScanStatus) lastScanStatus.textContent = new Date(m.timestamp).toLocaleString();
        if (profileLabel) profileLabel.textContent = m.profileType === 'back' ? 'Back profile' : 'Side profile';

        const list = document.getElementById('issues-list');
        list.innerHTML = m.issues.length ? m.issues.map(i => `<li class="issue-item">${i}</li>`).join('') : '<li class="issue-item good">Alignment Healthy</li>';
        
        const viz = document.getElementById('viz-placeholder');
        viz.innerHTML = `<img src="${m.imageData || canvasElement.toDataURL()}" alt="Analyzed posture scan">`;
        
        generateRecovery(m.issues);
        renderProgress();
        updateReportPreview();
    }

    function generateRecovery(issues) {
        const cal = document.getElementById('calendar-mount');
        cal.innerHTML = Array.from({length: 14}).map((_, i) => `
            <div class="cal-day ${i === 0 ? 'active' : ''}">
                <div style="font-weight:700;">Day ${i+1}</div>
                ${issues.slice(0, 2).map(issue => `<div class="cal-task" onclick="showGuide('${issue}')">${issue.split(' ')[0]}</div>`).join('')}
            </div>
        `).join('');

        const lib = document.getElementById('exercise-library');
        lib.innerHTML = issues.length ? issues.map(issue => {
            const ex = EXERCISE_DB[issue];
            return !ex ? '' : `
                <div class="panel exercise-card" onclick="showGuide('${issue}')">
                    <h4>${ex.title}</h4>
                    <p>${ex.desc}</p>
                </div>
            `;
        }).join('') : '<p>Healthy alignment detected. Maintenance stretches recommended.</p>';
    }

    window.showGuide = (issue) => {
        const ex = EXERCISE_DB[issue];
        if(!ex) return;
        document.getElementById('guide-body').innerHTML = `
            <h2 style="color: var(--primary); margin-bottom: 20px;">${ex.title}</h2>
            <p style="margin-bottom: 24px;">${ex.desc}</p>
            <div class="guide-steps">
                ${ex.steps.map((s, i) => `
                    <div class="guide-step">
                        <div class="guide-num">${i+1}</div>
                        <div>${s}</div>
                    </div>
                `).join('')}
            </div>
            <button class="btn btn-primary" style="width: 100%; margin-top: 20px;" onclick="closeGuide()">Mark as Complete</button>
        `;
        document.getElementById('guide-modal').style.display = 'flex';
    };

    window.closeGuide = () => document.getElementById('guide-modal').style.display = 'none';

    window.syncToCloud = async () => {
        if (!lastScanData || !currentClinicId) return;
        try {
            await addDoc(collection(db, "clinics", currentClinicId, "posture_records"), { ...lastScanData, syncedAt: new Date().toISOString(), nodeType: 'Clinical_v2.4' });
            loadAnonymizedRecords();
        } catch (err) { alert("Vault Connection Failed."); }
    };

    async function loadAnonymizedRecords() {
        if (!currentClinicId) return;
        try {
            const q = query(collection(db, "clinics", currentClinicId, "posture_records"));
            const querySnapshot = await getDocs(q);
            const list = document.getElementById('records-list');
            list.innerHTML = '';
            const cloudRecords = [];
            querySnapshot.forEach((doc) => {
                const r = doc.data();
                cloudRecords.push(r);
                list.innerHTML += `<div class="panel" style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <div><strong>${r.cyraxID}</strong> — ${new Date(r.timestamp).toLocaleDateString()}</div>
                    <div style="font-weight: 700; color: var(--primary);">${r.overall}/100</div>
                </div>`;
            });
            if (cloudRecords.length) {
                scanHistory = mergeScanHistory(scanHistory, cloudRecords);
                saveLocalHistory();
                renderProgress();
                updateReportPreview();
            }
        } catch (err) { console.error(err); }
    }

    function loadClinicSettings() {
        try {
            clinicSettings = { ...clinicSettings, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}') };
        } catch (err) {
            console.warn('Clinic settings could not be read', err);
        }
        if (settingsClinicName) settingsClinicName.value = clinicSettings.name || '';
        if (settingsClinicContact) settingsClinicContact.value = clinicSettings.contact || '';
        if (settingsClinicAddress) settingsClinicAddress.value = clinicSettings.address || '';
        updateClinicBranding();
    }

    function updateClinicBranding() {
        const display = clinicSettings.name || 'CyraxoHealth Clinic';
        if (clinicDisplayName) clinicDisplayName.textContent = currentClinicId ? display : display;
        if (!clinicLogoPreview) return;
        clinicLogoPreview.innerHTML = clinicSettings.logo
            ? `<img src="${clinicSettings.logo}" alt="Clinic logo preview">`
            : 'Logo';
    }

    window.saveClinicSettings = async () => {
        clinicSettings = {
            name: Security.sanitize(settingsClinicName?.value || 'CyraxoHealth Clinic'),
            contact: Security.sanitize(settingsClinicContact?.value || ''),
            address: Security.sanitize(settingsClinicAddress?.value || ''),
            logo: clinicSettings.logo || ''
        };
        localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(clinicSettings));
        updateClinicBranding();
        updateReportPreview();

        if (currentClinicId) {
            try {
                const clinicDocRef = doc(db, 'clinics', currentClinicId);
                await setDoc(clinicDocRef, { clinicSettings }, { merge: true });
                console.log('Synced clinic settings to Firestore.');
            } catch (err) {
                console.error('Error syncing clinic settings to Firestore:', err);
            }
        }
        alert('Clinic settings saved.');
    };

    if (clinicLogoUpload) {
        clinicLogoUpload.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                alert('Please upload an image file for the clinic logo.');
                return;
            }
            if (file.size > 750000) {
                alert('Logo file is too large. Please use an image under 750 KB.');
                return;
            }
            const reader = new FileReader();
            reader.onload = async () => {
                clinicSettings.logo = reader.result;
                localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(clinicSettings));
                updateClinicBranding();
                updateReportPreview();

                if (currentClinicId) {
                    try {
                        const clinicDocRef = doc(db, 'clinics', currentClinicId);
                        await setDoc(clinicDocRef, { clinicSettings }, { merge: true });
                        console.log('Synced clinic logo to Firestore.');
                    } catch (err) {
                        console.error('Error syncing clinic logo to Firestore:', err);
                    }
                }
            };
            reader.readAsDataURL(file);
        });
    }

    function loadLocalHistory() {
        try {
            scanHistory = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
        } catch (err) {
            scanHistory = [];
        }
        scanHistory = scanHistory.filter(Boolean).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        lastScanData = scanHistory[scanHistory.length - 1] || null;
        if (lastScanData) updateUI(lastScanData);
        renderProgress();
    }

    function saveLocalHistory() {
        try {
            localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(scanHistory.slice(-8)));
        } catch (err) {
            const compact = scanHistory.slice(-8).map((record, index, records) => (
                index === records.length - 1 ? record : { ...record, imageData: '' }
            ));
            localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(compact));
        }
    }

    function persistLocalScan(scan) {
        scanHistory = mergeScanHistory(scanHistory, [scan]).slice(-12);
        saveLocalHistory();
    }

    function mergeScanHistory(existing, incoming) {
        const byId = new Map();
        [...existing, ...incoming].forEach((record) => {
            if (!record || !record.timestamp) return;
            byId.set(record.cyraxID || record.timestamp, record);
        });
        return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    function renderProgress() {
        const chart = document.getElementById('progress-chart');
        const list = document.getElementById('records-list');
        if (!chart) return;
        if (scanHistory.length < 2) {
            chart.textContent = 'Log 2+ scans to unlock progress delta mapping.';
        } else {
            const first = scanHistory[0];
            const latest = scanHistory[scanHistory.length - 1];
            const delta = Number(latest.overall || 0) - Number(first.overall || 0);
            chart.innerHTML = `
                <div class="report-preview-grid" style="width:100%; padding:24px;">
                    <div class="report-preview-metric"><span>Baseline</span><strong>${first.overall}/100</strong></div>
                    <div class="report-preview-metric"><span>Latest</span><strong>${latest.overall}/100</strong></div>
                    <div class="report-preview-metric"><span>Change</span><strong>${delta >= 0 ? '+' : ''}${delta}</strong></div>
                    <div class="report-preview-metric"><span>Scans</span><strong>${scanHistory.length}</strong></div>
                </div>
            `;
        }
        if (list && scanHistory.length) {
            list.innerHTML = scanHistory.slice().reverse().map(r => `<div class="panel" style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div><strong>${r.cyraxID}</strong> - ${new Date(r.timestamp).toLocaleDateString()}</div>
                <div style="font-weight: 700; color: var(--primary);">${r.overall}/100</div>
            </div>`).join('');
        }
    }

    const escapeHtml = (value = '') => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const normalizePatientCode = (value = '') => value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');

    const getProtocolKey = (injury = '') => {
        const lower = injury.toLowerCase();
        if (/acl|mcl|meniscus|patella|knee/.test(lower)) return 'knee';
        if (/rotator|shoulder|scap|labrum/.test(lower)) return 'shoulder';
        if (/ankle|achilles|foot|sprain/.test(lower)) return 'ankle';
        if (/lumbar|back|spine|disc/.test(lower)) return 'back';
        if (/neck|cervical|whiplash/.test(lower)) return 'neck';
        if (/hip|pelvis|groin/.test(lower)) return 'hip';
        return 'general';
    };

    function generatePatientCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = 'PX-';
        for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    }

    const getPatientDocId = (clinicId, code) => `${clinicId}_${code}`.replace(/[^A-Za-z0-9_-]/g, '_');

    function getVariedDailyExercises(sessionPool, dayIndex, phase = 'Mobility', variant = 0) {
        const uniquePool = (sessionPool || [])
            .filter(Boolean)
            .filter((exercise, index, list) => list.findIndex(item => item.title === exercise.title) === index);
        if (!uniquePool.length) return [];
        const lengthPattern = [4, 5, 3, 5, 4, 3, 5];
        const sessionLength = Math.min(uniquePool.length, lengthPattern[dayIndex % lengthPattern.length]);
        const usedTitles = new Set();
        const exercises = [];
        for (let offset = 0; offset < sessionLength; offset += 1) {
            let poolIndex = (dayIndex * 3 + offset * 2 + Math.floor(dayIndex / 2) + variant + (phase === 'Recovery' ? 1 : 0)) % uniquePool.length;
            let exercise = uniquePool[poolIndex];
            let guard = 0;
            while (usedTitles.has(exercise.title) && guard < uniquePool.length) {
                poolIndex = (poolIndex + 1) % uniquePool.length;
                exercise = uniquePool[poolIndex];
                guard += 1;
            }
            usedTitles.add(exercise.title);
            exercises.push({
                ...exercise,
                targetReps: phase === 'Strength' ? 12 : phase === 'Control' ? 10 : phase === 'Recovery' ? 6 : 8,
                steps: EXERCISE_STEPS[exercise.title] || [exercise.detail, exercise.cue]
            });
        }
        return exercises;
    }

    function normalizeScheduleVariety(patient) {
        const schedule = patient?.plan?.schedule || [];
        if (!schedule.length) return schedule;
        const protocol = patient.plan?.exercises?.length
            ? patient.plan.exercises
            : (PROTOCOL_LIBRARY[getProtocolKey(patient.injury)] || PROTOCOL_LIBRARY.general);
        const scheduledExercises = schedule.flatMap(item => item.exercises || []);
        const sessionPool = [...protocol, ...scheduledExercises, ...PROTOCOL_LIBRARY.general]
            .filter((exercise, index, list) => exercise?.title && list.findIndex(item => item.title === exercise.title) === index);
        const seenSignatures = new Set();
        return schedule.map((item, index) => {
            const phase = item.phase || ['Mobility', 'Control', 'Strength', 'Recovery'][index % 4];
            const variedExercises = getVariedDailyExercises(sessionPool, index, phase);
            let exercises = item.exercises?.length ? item.exercises : variedExercises;
            let signature = exercises.map(ex => ex.title).sort().join('|');
            if (!signature || seenSignatures.has(signature)) {
                exercises = variedExercises;
                signature = exercises.map(ex => ex.title).sort().join('|');
                let variant = 1;
                while (seenSignatures.has(signature) && variant <= sessionPool.length * 2) {
                    exercises = getVariedDailyExercises(sessionPool, index, phase, variant);
                    signature = exercises.map(ex => ex.title).sort().join('|');
                    variant += 1;
                }
            }
            seenSignatures.add(signature);
            return {
                ...item,
                phase,
                title: item.title || `${phase} session`,
                instruction: `${exercises.length} exercises · ${exercises[0]?.sets || 'Clinic assigned'}`,
                focus: item.focus || exercises[0]?.detail || 'Complete the assigned sequence with controlled form.',
                exercises
            };
        });
    }

    function getPatientScheduleDate(patient, day) {
        const date = new Date(patient?.createdAt || Date.now());
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() + Math.max(0, Number(day || 1) - 1));
        return date;
    }

    function formatPatientScheduleDate(patient, day, options = { month: 'short', day: 'numeric' }) {
        return getPatientScheduleDate(patient, day).toLocaleDateString(undefined, options);
    }

    function buildAiRecoveryPlan(patient) {
        const protocol = PROTOCOL_LIBRARY[getProtocolKey(patient.injury)] || PROTOCOL_LIBRARY.general;
        const sessionPool = [...protocol, ...PROTOCOL_LIBRARY.general]
            .filter((exercise, index, list) => list.findIndex(item => item.title === exercise.title) === index);
        const timeline = Math.max(1, Number(patient.timeline || 6));
        const unit = patient.timelineUnit || 'weeks';
        const totalDays = unit === 'days' ? Math.min(42, timeline) : Math.min(84, timeline * 7);
        const schedule = Array.from({ length: Math.min(totalDays, 28) }).map((_, index) => {
            const day = index + 1;
            const dayPattern = ['Mobility', 'Control', 'Strength', 'Recovery'][index % 4];
            const phase = day <= Math.ceil(totalDays * 0.25) ? 'Mobility' : dayPattern;
            const exercises = getVariedDailyExercises(sessionPool, index, phase);
            return {
                day,
                phase,
                title: `${phase} session`,
                instruction: `${exercises.length} exercises · ${exercises[0].sets}`,
                focus: day % 7 === 0 ? 'Recovery check-in and symptom review' : exercises[0].detail,
                exercises
            };
        });
        return {
            protocolKey: getProtocolKey(patient.injury),
            exercises: protocol,
            schedule,
            summary: `AI-generated ${timeline} ${unit} plan for ${patient.injury || 'clinical recovery'} using clinic-entered restrictions and motion-analysis progress.`
        };
    }

    function readLocalPatients() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEYS.patients) || '[]');
        } catch (err) {
            return [];
        }
    }

    function saveLocalPatients(patients) {
        clinicPatients = patients;
        localStorage.setItem(STORAGE_KEYS.patients, JSON.stringify(patients));
    }

    async function loadClinicPatients() {
        const local = readLocalPatients().filter(p => !currentClinicId || p.clinicId === currentClinicId);
        clinicPatients = local;
        renderPatientRoster();
        if (!currentClinicId) return;
        try {
            const snapshot = await getDocs(query(collection(db, 'clinics', currentClinicId, 'posture_patients')));
            const cloud = [];
            snapshot.forEach((item) => cloud.push(item.data()));
            const byCode = new Map([...local, ...cloud].filter(p => p?.code).map(p => [p.code, p]));
            saveLocalPatients(Array.from(byCode.values()));
            renderPatientRoster();
        } catch (err) {
            console.warn('Patient roster cloud load skipped:', err);
        }
    }

    async function savePatientRecord(patient) {
        const existing = readLocalPatients().filter(p => p.code !== patient.code);
        const patientDocId = patient.patientDocId || getPatientDocId(patient.clinicId || 'LOCAL-CLINIC', patient.code);
        const normalizedPatient = { ...patient, patientDocId };
        saveLocalPatients([normalizedPatient, ...existing]);
        if (!patient.clinicId) return;
        try {
            await setDoc(doc(db, 'clinics', normalizedPatient.clinicId, 'posture_patients', normalizedPatient.code), normalizedPatient, { merge: true });
            await setDoc(doc(db, 'patients', patientDocId), {
                ...normalizedPatient,
                clinicPatientKey: patientDocId
            }, { merge: true });
            await setDoc(doc(db, 'patient_access', normalizedPatient.code), {
                code: normalizedPatient.code,
                clinicId: normalizedPatient.clinicId,
                patientDocId,
                patientName: normalizedPatient.patientName,
                injury: normalizedPatient.injury,
                plan: normalizedPatient.plan,
                baselineRom: normalizedPatient.baselineRom,
                targetRom: normalizedPatient.targetRom,
                timeline: normalizedPatient.timeline,
                timelineUnit: normalizedPatient.timelineUnit,
                clinicName: normalizedPatient.clinicName,
                status: 'Active',
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (err) {
            console.warn('Patient record saved locally but cloud sync failed:', err);
        }
    }

    window.openPatientModal = () => {
        document.getElementById('patient-manager-modal').style.display = 'flex';
    };

    window.closePatientModal = () => {
        document.getElementById('patient-manager-modal').style.display = 'none';
    };

    window.createPatientFromManager = async () => {
        const status = document.getElementById('patient-form-status');
        const patientName = Security.sanitize(document.getElementById('patient-form-name')?.value || '');
        const injury = Security.sanitize(document.getElementById('patient-form-injury')?.value || '');
        const timeline = Number(document.getElementById('patient-form-timeline')?.value || 0);
        const timelineUnit = document.getElementById('patient-form-unit')?.value || 'weeks';
        const baselineRom = Math.max(0, Math.min(100, Number(document.getElementById('patient-form-rom')?.value || 50)));
        const targetRom = Math.max(baselineRom + 1, Math.min(100, Number(document.getElementById('patient-form-target')?.value || 90)));
        const notes = Security.sanitize(document.getElementById('patient-form-notes')?.value || '');
        if (!patientName || !injury || !timeline) {
            status.textContent = 'Add patient ID, injury, and expected recovery time.';
            status.classList.add('danger');
            return;
        }
        let code = generatePatientCode();
        const existingCodes = new Set(readLocalPatients().map(p => p.code));
        while (existingCodes.has(code)) code = generatePatientCode();
        const patient = {
            code,
            clinicId: currentClinicId || 'LOCAL-CLINIC',
            patientDocId: getPatientDocId(currentClinicId || 'LOCAL-CLINIC', code),
            clinicName: clinicSettings.name || 'CyraxoHealth Clinic',
            patientName,
            injury,
            timeline,
            timelineUnit,
            baselineRom,
            targetRom,
            notes,
            plan: buildAiRecoveryPlan({ injury, timeline, timelineUnit }),
            sessions: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await savePatientRecord(patient);
        renderPatientRoster();
        status.classList.remove('danger');
        status.textContent = `Access code generated: ${code}`;
        ['patient-form-name', 'patient-form-injury', 'patient-form-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    };

    window.renderPatientRoster = () => {
        const mount = document.getElementById('patient-roster-list');
        if (!mount) return;
        const term = (document.getElementById('patient-roster-search')?.value || '').toLowerCase();
        const patients = clinicPatients
            .filter(p => [p.patientName, p.injury, p.code].join(' ').toLowerCase().includes(term))
            .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        if (!patients.length) {
            mount.innerHTML = '<div class="empty-state">No patients added yet.</div>';
            return;
        }
        mount.innerHTML = patients.map((p) => {
            const sessions = p.sessions || [];
            const latest = sessions[sessions.length - 1];
            const improvement = getPatientImprovement(p);
            return `
                <article class="patient-roster-item ${selectedClinicPatient?.code === p.code ? 'selected' : ''}" onclick="selectClinicPatient('${escapeHtml(p.code)}')">
                    <div>
                        <strong>${escapeHtml(p.patientName)}</strong>
                        <p>${escapeHtml(p.injury)} · ${escapeHtml(String(p.timeline))} ${escapeHtml(p.timelineUnit || 'weeks')}</p>
                        <span class="patient-code">${escapeHtml(p.code)}</span>
                    </div>
                    <div class="patient-roster-metrics">
                        <span>${sessions.length} sessions</span>
                        <span>${latest ? `${latest.rom}% ROM` : `${p.baselineRom}% baseline`}</span>
                        <span>${improvement}% improvement</span>
                    </div>
                </article>
            `;
        }).join('');
    };

    window.selectClinicPatient = (code) => {
        const patient = clinicPatients.find(p => p.code === code);
        if (!patient) return;
        selectedClinicPatient = patient;
        renderPatientRoster();
        updatePatientContextNav();
        const recoveryTitle = document.querySelector('#view-recovery h2');
        const recoveryCopy = document.querySelector('#view-recovery .panel p');
        const progressTitle = document.querySelector('#view-progress h2');
        if (recoveryTitle) recoveryTitle.textContent = `${patient.patientName || 'Patient'} Recovery Plan`;
        if (recoveryCopy) recoveryCopy.textContent = `${patient.injury || 'Clinical recovery'} · ${patient.timeline || 6} ${patient.timelineUnit || 'weeks'} protocol.`;
        if (progressTitle) progressTitle.textContent = `${patient.patientName || 'Patient'} Progress Map`;
        window.switchTab('recovery');
    };

    async function loginPatientByCode(rawCode, silent = false) {
        const code = normalizePatientCode(rawCode);
        const error = document.getElementById('patient-login-error');
        if (!code) {
            if (!silent) error.textContent = 'Enter a valid access code.';
            return;
        }
        let patient = readLocalPatients().find(p => p.code === code);
        try {
            const accessSnap = await getDoc(doc(db, 'patient_access', code));
            if (accessSnap.exists()) {
                const access = accessSnap.data();
                if (access.patientDocId) {
                    const patientSnap = await getDoc(doc(db, 'patients', access.patientDocId));
                    if (patientSnap.exists()) patient = patientSnap.data();
                }
                if (!patient) {
                    patient = {
                        ...access,
                        patientName: access.patientName || 'Patient',
                        sessions: access.sessionHistory || [],
                        createdAt: access.updatedAt || new Date().toISOString()
                    };
                }
            }
        } catch (err) {
            console.warn('Patient cloud login fell back to local cache:', err);
        }
        if (!patient) {
            if (!silent) error.textContent = 'Code not found. Check the code from your clinic.';
            sessionStorage.removeItem(STORAGE_KEYS.patientSession);
            return;
        }
        activePatient = patient;
        sessionStorage.setItem(STORAGE_KEYS.patientSession, code);
        document.getElementById('patient-code-gate').style.display = 'none';
        document.getElementById('app-mount').style.display = 'none';
        document.getElementById('patient-dashboard').style.display = 'grid';
        renderPatientDashboard();
    }

    window.patientCodeLogin = () => loginPatientByCode(document.getElementById('patient-access-code')?.value || '');

    window.patientLogout = () => {
        sessionStorage.removeItem(STORAGE_KEYS.patientSession);
        activePatient = null;
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
        patientVoiceAssistant.speechToken += 1;
        setPatientAssistantSpeaking(false);
        window.stopPatientMotionSession(false);
        showPatientEntry();
    };

    function getPatientImprovement(patient) {
        const sessions = patient.sessions || [];
        const latestRom = sessions.length ? Number(sessions[sessions.length - 1].rom) : Number(patient.baselineRom || 0);
        const baseline = Number(patient.baselineRom || 0);
        const target = Number(patient.targetRom || 100);
        return Math.max(0, Math.min(100, Math.round(((latestRom - baseline) / Math.max(1, target - baseline)) * 100)));
    }

    window.switchPatientView = (id) => {
        document.querySelectorAll('.patient-view').forEach(view => view.classList.remove('active'));
        document.getElementById(`patient-view-${id}`)?.classList.add('active');
        document.querySelectorAll('.patient-menu-item').forEach(item => item.classList.remove('active'));
        document.getElementById(`patient-nav-${id}`)?.classList.add('active');
    };

    function renderPatientDashboard() {
        if (!activePatient) return;
        if (!activePatient.plan?.exercises?.length || !activePatient.plan?.schedule?.length || !activePatient.plan.schedule[0]?.exercises?.length) {
            activePatient = {
                ...activePatient,
                plan: buildAiRecoveryPlan({
                    injury: activePatient.injury || 'Clinical recovery',
                    timeline: activePatient.timeline || 6,
                    timelineUnit: activePatient.timelineUnit || 'weeks'
                })
            };
        }
        activePatient.plan.schedule = normalizeScheduleVariety(activePatient);
        const sessions = activePatient.sessions || [];
        const latest = sessions[sessions.length - 1];
        const rom = latest ? latest.rom : activePatient.baselineRom || 50;
        const progress = getPatientImprovement(activePatient);
        document.getElementById('patient-dash-title').textContent = activePatient.patientName || 'Recovery Plan';
        document.getElementById('patient-dash-subtitle').textContent = `${activePatient.injury || 'Clinical recovery'} · ${activePatient.timeline || 6} ${activePatient.timelineUnit || 'weeks'} plan from ${activePatient.clinicName || 'your clinic'}`;
        document.getElementById('patient-stat-progress').textContent = `${progress}%`;
        document.getElementById('patient-stat-rom').textContent = `${rom}%`;
        document.getElementById('patient-stat-improvement').textContent = `${Math.max(0, Number(rom) - Number(activePatient.baselineRom || 0))}%`;
        document.getElementById('patient-stat-sessions').textContent = String(sessions.length);
        document.getElementById('patient-side-code').textContent = activePatient.code || 'Recovery code';
        const exercises = activePatient.plan?.exercises || [];
        const todayItem = getTodaySession();
        document.getElementById('patient-today-focus').innerHTML = todayItem ? `
            <strong>Day ${todayItem.day}: ${escapeHtml(todayItem.title)}</strong>
            <span>${escapeHtml(todayItem.phase)} - ${todayItem.exercises.length} exercises for today's session.</span>
            <div class="daily-session-mini">${todayItem.exercises.map((ex, index) => `<span>${index + 1}. ${escapeHtml(ex.title)}</span>`).join('')}</div>
            <button class="btn btn-primary" onclick="startTodaySession()">Start Now</button>
        ` : '<div class="empty-state">Your clinic plan is still being prepared.</div>';
        document.getElementById('patient-recent-activity').innerHTML = renderPatientSessionHistory(sessions.slice(-3));
        document.getElementById('patient-progress-detail').innerHTML = renderPatientProgressDetail(activePatient);
        document.getElementById('patient-milestone-list').innerHTML = renderPatientMilestones(activePatient);
        document.getElementById('patient-exercise-list').innerHTML = (activePatient.plan?.exercises || []).map(ex => `
            <article class="patient-exercise-card">
                <h3>${escapeHtml(ex.title)}</h3>
                <p>${escapeHtml(ex.detail)}</p>
                <strong>${escapeHtml(ex.sets)}</strong>
                <span>${escapeHtml(ex.cue)}</span>
                <ol class="exercise-step-list">${getExerciseSteps(ex).map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
            </article>
        `).join('');
        renderPatientScheduleCalendar(todayItem);
        renderDailySessionGuide();
    }

    function renderPatientScheduleCalendar(todayItem = getTodaySession()) {
        const mount = document.getElementById('patient-schedule-list');
        if (!mount) return;
        const schedule = activePatient?.plan?.schedule || [];
        if (!schedule.length) {
            mount.innerHTML = '<div class="empty-state">Your clinic plan is still being prepared.</div>';
            return;
        }
        const expandedDay = patientExpandedScheduleDay || todayItem?.day || schedule[0].day;
        const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const leadCells = getPatientScheduleDate(activePatient, schedule[0].day).getDay();
        mount.innerHTML = `
            <div class="patient-calendar-header">
                <div>
                    <strong>${formatPatientScheduleDate(activePatient, schedule[0].day, { month: 'long', day: 'numeric' })} - ${formatPatientScheduleDate(activePatient, schedule[schedule.length - 1].day, { month: 'long', day: 'numeric' })}</strong>
                    <span>${schedule.length} day recovery calendar · tap any day to expand</span>
                </div>
            </div>
            <div class="patient-calendar-weekdays">
                ${weekDays.map(day => `<span>${day}</span>`).join('')}
            </div>
            <div class="patient-calendar-grid">
                ${Array.from({ length: leadCells }).map(() => '<div class="patient-calendar-empty"></div>').join('')}
                ${schedule.map(item => renderPatientScheduleDay(item, todayItem, expandedDay)).join('')}
            </div>
        `;
    }

    function renderPatientScheduleDay(item, todayItem, expandedDay) {
        const isToday = item.day === todayItem?.day;
        const isExpanded = item.day === expandedDay;
        const exercises = item.exercises || [];
        return `
            <button class="patient-calendar-day ${isToday ? 'today' : ''} ${isExpanded ? 'expanded' : ''}" type="button" onclick="expandPatientScheduleDay(${item.day})" aria-expanded="${isExpanded}">
                <span class="calendar-day-date">${formatPatientScheduleDate(activePatient, item.day, { month: 'short', day: 'numeric' })}</span>
                <strong>${isToday ? 'Today' : `Day ${item.day}`}</strong>
                <span>${escapeHtml(item.phase)} · ${exercises.length || 1} exercises</span>
                <div class="calendar-exercise-preview">
                    ${exercises.slice(0, 3).map(ex => `<small>${escapeHtml(ex.title)}</small>`).join('')}
                </div>
            </button>
            ${isExpanded ? `
                <article class="patient-schedule-item patient-calendar-expanded ${isToday ? 'today' : ''}">
                    <div class="schedule-day-head">
                        <div>
                            <strong>${isToday ? "Today's Session" : `Day ${item.day}`}: ${escapeHtml(item.title)}</strong>
                            <span>${formatPatientScheduleDate(activePatient, item.day, { weekday: 'long', month: 'long', day: 'numeric' })} · ${escapeHtml(item.phase)} · ${exercises.length || 1} exercises</span>
                        </div>
                        ${isToday ? '<button class="btn btn-primary" onclick="startTodaySession()">Start Now</button>' : ''}
                    </div>
                    <div class="daily-session-list">
                        ${exercises.map((ex, index) => `
                            <div>
                                <strong>${index + 1}. ${escapeHtml(ex.title)}</strong>
                                <span>${escapeHtml(ex.sets)} · Target ${ex.targetReps || 10} reps</span>
                                <ol class="exercise-step-list compact">${getExerciseSteps(ex).map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
                            </div>
                        `).join('')}
                    </div>
                </article>
            ` : ''}
        `;
    }

    window.expandPatientScheduleDay = (day) => {
        patientExpandedScheduleDay = Number(day);
        renderPatientScheduleCalendar(getTodaySession());
    };

    function getExerciseSteps(exercise = {}) {
        return exercise.steps?.length ? exercise.steps : EXERCISE_STEPS[exercise.title] || [exercise.detail || 'Move slowly through the assigned range.', exercise.cue || 'Stop if pain increases.'];
    }

    function getTodaySession() {
        const schedule = activePatient?.plan?.schedule || [];
        if (!schedule.length) return null;
        const sessionsCompleted = activePatient.sessions?.filter(session => session.dailySessionComplete).length || 0;
        return schedule[Math.min(sessionsCompleted, schedule.length - 1)];
    }

    window.startTodaySession = () => {
        const today = getTodaySession();
        if (!today) return;
        activeDailySession = {
            day: today.day,
            phase: today.phase,
            exercises: today.exercises || [],
            index: 0,
            completed: []
        };
        window.switchPatientView('motion');
        startDailyExercise(0);
    };

    function startDailyExercise(index) {
        if (!activeDailySession?.exercises?.[index]) return;
        activeDailySession.index = index;
        const exercise = activeDailySession.exercises[index];
        renderCurrentScheduledExercise(exercise, index);
        renderDailySessionGuide();
        document.getElementById('patient-motion-result').textContent = `Exercise ${index + 1} of ${activeDailySession.exercises.length}: ${exercise.title}. Press Start Rep Counter when ready.`;
        updatePatientAssistant(`Exercise ${index + 1}: ${exercise.title}. ${exercise.cue || 'Move slowly and stay in a comfortable range.'}`, 'Ready to coach.', true);
    }

    function renderCurrentScheduledExercise(exercise, index) {
        const card = document.getElementById('patient-current-exercise');
        if (!card || !exercise) return;
        card.innerHTML = `
            <span>Current scheduled exercise</span>
            <strong>${index + 1}. ${escapeHtml(exercise.title)}</strong>
            <p>${escapeHtml(exercise.detail || '')}</p>
            <div class="current-exercise-meta">
                <span>${escapeHtml(exercise.sets || '')}</span>
                <span>Target ${exercise.targetReps || 10} reps</span>
            </div>
            <ol class="exercise-step-list">${getExerciseSteps(exercise).map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
        `;
        document.getElementById('patient-live-target').textContent = String(exercise.targetReps || 10);
    }

    function renderDailySessionGuide() {
        const guide = document.getElementById('patient-session-guide');
        if (!guide) return;
        if (!activeDailySession) {
            const today = getTodaySession();
            guide.innerHTML = today ? `
                <strong>Today's Session: Day ${today.day}</strong>
                <span>${today.exercises.length} scheduled exercises. Start from Schedule or Overview to be walked through them in order.</span>
            ` : 'Select Start Now from today\'s schedule to begin your daily exercises.';
            return;
        }
        guide.innerHTML = `
            <strong>Day ${activeDailySession.day} · Exercise ${activeDailySession.index + 1} of ${activeDailySession.exercises.length}</strong>
            <span>${activeDailySession.exercises.map((ex, index) => `${index === activeDailySession.index ? '>' : activeDailySession.completed[index] ? 'Done:' : '-'} ${ex.title}`).join('  ')}</span>
        `;
    }

    function normalizePatientAssistantResponse(response) {
        if (typeof response === 'string') {
            return { summary: response, details: [] };
        }
        return {
            summary: response?.summary || 'I can help with today\'s session.',
            details: Array.isArray(response?.details) ? response.details.filter(Boolean) : [],
            note: response?.note || ''
        };
    }

    function renderPatientAssistantResponse(response) {
        const normalized = normalizePatientAssistantResponse(response);
        return `
            <strong>${escapeHtml(normalized.summary)}</strong>
            ${normalized.details.length ? `<ul>${normalized.details.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
            ${normalized.note ? `<small>${escapeHtml(normalized.note)}</small>` : ''}
        `;
    }

    function getPatientAssistantSpeechText(response) {
        const normalized = normalizePatientAssistantResponse(response);
        return [normalized.summary, ...normalized.details, normalized.note].filter(Boolean).join(' ');
    }

    function getPatientAssistantSpeechChunks(response) {
        const normalized = normalizePatientAssistantResponse(response);
        const chunks = [normalized.summary, ...normalized.details, normalized.note]
            .filter(Boolean)
            .map(item => item.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        return chunks.length ? chunks : [getPatientAssistantSpeechText(response)];
    }

    function getPreferredPatientVoice() {
        if (!('speechSynthesis' in window)) return null;
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return null;
        const scoreVoice = (voice) => {
            const name = voice.name.toLowerCase();
            const lang = (voice.lang || '').toLowerCase();
            let score = 0;
            if (lang.startsWith('en-us')) score += 25;
            else if (lang.startsWith('en')) score += 15;
            if (/enhanced|premium|neural|natural|online/.test(name)) score += 30;
            if (/ava|jenny|aria|emma|sonia|samantha|google us english|nicky|zoe|allison/.test(name)) score += 20;
            if (/compact|novelty|whisper|robot|fred|zarvox/.test(name)) score -= 35;
            if (!voice.localService) score += 5;
            return score;
        };
        return voices.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || voices[0];
    }

    function updatePatientAssistant(message, status = 'Ready when you are.', speak = false, forceSpeak = false) {
        const bubble = document.getElementById('patient-voice-bubble');
        const statusEl = document.getElementById('patient-voice-status');
        if (bubble) bubble.innerHTML = renderPatientAssistantResponse(message);
        if (statusEl) statusEl.textContent = status;
        if (speak) speakPatientAssistant(message, forceSpeak);
    }

    function setPatientAssistantSpeaking(isSpeaking) {
        document.getElementById('patient-voice-sprite')?.classList.toggle('speaking', Boolean(isSpeaking));
    }

    window.togglePatientVoicePanel = (forceOpen = null) => {
        patientVoiceAssistant.panelOpen = forceOpen === null ? !patientVoiceAssistant.panelOpen : Boolean(forceOpen);
        const assistant = document.getElementById('patient-voice-assistant');
        const sprite = document.getElementById('patient-voice-sprite');
        assistant?.classList.toggle('is-open', patientVoiceAssistant.panelOpen);
        if (sprite) {
            sprite.setAttribute('aria-label', patientVoiceAssistant.panelOpen ? 'Minimize Cyraxo Coach' : 'Open Cyraxo Coach');
            sprite.setAttribute('aria-expanded', String(patientVoiceAssistant.panelOpen));
        }
    };

    function speakPatientAssistant(message, forceSpeak = false) {
        if ((!patientVoiceAssistant.enabled && !forceSpeak) || !('speechSynthesis' in window)) return;
        patientVoiceAssistant.enabled = true;
        const toggle = document.getElementById('patient-voice-toggle');
        if (toggle) toggle.textContent = 'Voice Off';
        window.speechSynthesis.cancel();
        patientVoiceAssistant.speechToken += 1;
        const speechToken = patientVoiceAssistant.speechToken;
        patientVoiceAssistant.voice = patientVoiceAssistant.voice || getPreferredPatientVoice();
        const chunks = getPatientAssistantSpeechChunks(message);
        const speakChunk = (index = 0) => {
            if (speechToken !== patientVoiceAssistant.speechToken) return;
            if (index >= chunks.length) {
                setPatientAssistantSpeaking(false);
                return;
            }
            const utterance = new SpeechSynthesisUtterance(chunks[index]);
            if (patientVoiceAssistant.voice) utterance.voice = patientVoiceAssistant.voice;
            utterance.rate = [1.04, 0.99, 1.02, 1.07][index % 4];
            utterance.pitch = [1.05, 1, 1.03, 0.99][index % 4];
            utterance.volume = 0.96;
            utterance.onstart = () => setPatientAssistantSpeaking(true);
            utterance.onend = () => window.setTimeout(() => speakChunk(index + 1), index === 0 ? 110 : 85);
            utterance.onerror = () => window.setTimeout(() => speakChunk(index + 1), 80);
            window.speechSynthesis.speak(utterance);
        };
        speakChunk();
    }

    if ('speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = () => {
            patientVoiceAssistant.voice = getPreferredPatientVoice();
        };
    }

    window.togglePatientVoiceAssistant = () => {
        window.togglePatientVoicePanel(true);
        patientVoiceAssistant.enabled = !patientVoiceAssistant.enabled;
        const toggle = document.getElementById('patient-voice-toggle');
        if (toggle) toggle.textContent = patientVoiceAssistant.enabled ? 'Voice Off' : 'Voice On';
        if (!patientVoiceAssistant.enabled) {
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            patientVoiceAssistant.speechToken += 1;
            setPatientAssistantSpeaking(false);
            updatePatientAssistant('Voice coaching is paused. Tap Ask or Send and I will still talk back to direct questions.', 'Voice paused.');
            return;
        }
        updatePatientAssistant('Hi, I am Cyraxo Coach. I will keep cues short and talk you through the important moments.', 'Voice coaching on.', true, true);
    };

    function getCurrentScheduledExercise() {
        if (activeDailySession?.exercises?.[activeDailySession.index]) return activeDailySession.exercises[activeDailySession.index];
        return getTodaySession()?.exercises?.[0] || null;
    }

    function questionHas(question, words = []) {
        return words.some(word => new RegExp(`\\b${word}\\b`, 'i').test(question));
    }

    function getSessionTimeEstimate(exercises = []) {
        const count = exercises.length || 1;
        return `${Math.max(8, count * 4)} to ${Math.max(12, count * 6)} minutes`;
    }

    function answerPatientAssistantQuestion(rawQuestion = '') {
        const question = rawQuestion.toLowerCase().replace(/[^\w\s']/g, ' ');
        const today = getTodaySession();
        const exercise = getCurrentScheduledExercise();
        const tracker = patientRepTracker;
        const todayExercises = today?.exercises || [];
        if (!question.trim()) {
            return {
                summary: 'Sure - what do you want to know?',
                details: ['Try asking about today\'s plan, reps, form, rest, time, equipment, camera setup, soreness, progress, or what comes next.']
            };
        }
        if (/hello|hi|hey|thanks|thank you/.test(question)) {
            return {
                summary: /thank/.test(question) ? 'You got it.' : 'Hey, I am here with you.',
                details: ['Ask me anything about the session, or start moving and I will keep the cues short.']
            };
        }
        if (/pain|hurt|dizzy|numb|tingle|swelling|sharp|unsafe|emergency/.test(question)) {
            return {
                summary: 'Pause there - safety comes first.',
                details: ['Stop the exercise if pain is sharp, unusual, or increasing.', 'If symptoms do not settle, follow your clinic instructions and contact your care team.'],
                note: 'I can coach the plan, but I cannot diagnose symptoms.'
            };
        }
        if (/sore|stiff|tight|tired|fatigue|cramp/.test(question)) {
            return {
                summary: 'A little effort can be normal; sharp symptoms are not.',
                details: ['Slow the pace and reduce the range if you feel stiff or tired.', 'Stop and check with your clinic if symptoms spike, feel sharp, or do not settle.']
            };
        }
        if (/rest|break|pause|between|recover/.test(question)) {
            return {
                summary: 'Take a short reset between sets.',
                details: ['Rest about 30 to 60 seconds, or longer if your clinic told you to.', 'Start again when your breathing and form feel controlled.']
            };
        }
        if (/time|long|duration|minutes|finish|take/.test(question)) {
            return today ? {
                summary: `Today should take about ${getSessionTimeEstimate(todayExercises)}.`,
                details: [`You have ${todayExercises.length} exercises.`, 'Move slowly enough that your form stays clean.']
            } : { summary: 'Once your plan is loaded, I can estimate the session time.' };
        }
        if (/equipment|band|chair|wall|mat|need|setup/.test(question)) {
            const detail = exercise?.detail || todayExercises[0]?.detail || '';
            return {
                summary: 'Use the setup your clinic assigned.',
                details: [
                    exercise ? `For ${exercise.title}: ${detail || exercise.cue || 'set up in a stable, comfortable position.'}` : 'Most sessions only need open space and a stable surface if your exercise calls for support.',
                    'Keep water nearby and clear the floor around you.'
                ]
            };
        }
        if (/camera|frame|see|tracking|pose|video/.test(question)) {
            return {
                summary: 'Let the camera see your full movement.',
                details: ['Step back until your shoulders, hips, knees, and ankles are visible.', 'Keep the camera steady and use good lighting.', 'If tracking feels off, pause and re-center before continuing.']
            };
        }
        if (/motivate|motivation|encourage|hard|can't|cant|difficult|give up/.test(question)) {
            return {
                summary: 'Stay with the next clean rep.',
                details: ['You do not need to rush this.', 'One controlled rep is more useful than several sloppy ones.', 'I will count the steady ones with you.']
            };
        }
        if (questionHas(question, ['how', 'what']) && questionHas(question, ['many', 'number']) && questionHas(question, ['exercise', 'exercises'])) {
            return today ? {
                summary: `You have ${todayExercises.length} exercises today.`,
                details: todayExercises.map((item, index) => `${index + 1}. ${item.title}`)
            } : { summary: 'Your clinic plan is still being prepared.' };
        }
        if (/sets|rounds|volume/.test(question)) {
            return exercise ? {
                summary: `For ${exercise.title}, follow ${exercise.sets || 'the clinic assigned sets'}.`,
                details: [`Target: ${exercise.targetReps || 10} reps.`, exercise.cue || 'Keep each rep smooth and controlled.']
            } : {
                summary: 'Start today\'s session and I will show the sets for the current exercise.'
            };
        }
        if (/next|after|following/.test(question)) {
            if (!activeDailySession) {
                return todayExercises[0] ? {
                    summary: `First up is ${todayExercises[0].title}.`,
                    details: [todayExercises[0].cue || todayExercises[0].detail || 'Move slowly and stay controlled.']
                } : { summary: 'Start today from the schedule when you are ready.' };
            }
            const next = activeDailySession.exercises?.[activeDailySession.index + 1];
            return next ? {
                summary: `Next up: ${next.title}.`,
                details: [next.cue || next.detail || 'Move slowly and stay controlled.']
            } : { summary: 'This is the final exercise in today\'s session.' };
        }
        if (/rep|count|target|many/.test(question)) {
            if (tracker) {
                return {
                    summary: `${tracker.reps} of ${tracker.targetReps} reps are counted.`,
                    details: [`Current exercise: ${tracker.exerciseTitle}`, `${Math.max(0, tracker.targetReps - tracker.reps)} reps remaining.`]
                };
            }
            return exercise ? {
                summary: `${exercise.title} is set for ${exercise.targetReps || 10} reps.`,
                details: [exercise.sets || 'Use the clinic assigned volume.', 'Press Start Rep Counter when you are in frame.']
            } : { summary: 'Start today\'s session and I will track the target reps.' };
        }
        if (/form|cue|technique|posture|doing|perform/.test(question) || (questionHas(question, ['how']) && questionHas(question, ['do', 'perform', 'move']))) {
            return exercise ? {
                summary: `For ${exercise.title}, keep it smooth.`,
                details: [exercise.cue || 'Move smoothly and avoid rushing.', exercise.detail || 'Stay inside a comfortable range.', `${exercise.sets || 'Complete the prescribed sets'} with a target of ${exercise.targetReps || 10} reps.`]
            } : {
                summary: 'Use smooth, comfortable movement.',
                details: ['Breathe normally.', 'Stop if symptoms increase.', 'Start today\'s session so I can give exercise-specific cues.']
            };
        }
        if (/breathe|breathing|inhale|exhale/.test(question)) {
            return {
                summary: 'Keep breathing easy.',
                details: ['Exhale through effort.', 'Avoid holding your breath during the hard part of the rep.', 'Reset for one breath if your shoulders or jaw tense up.']
            };
        }
        if (/progress|rom|range|improvement/.test(question)) {
            const progress = getPatientImprovement(activePatient || {});
            const latest = activePatient?.sessions?.[(activePatient.sessions || []).length - 1];
            return latest
                ? {
                    summary: `Your overall progress is ${progress}%.`,
                    details: [`Latest ROM: ${latest.rom}%`, `Latest form score: ${latest.smoothness}%`, `Latest exercise: ${latest.exerciseTitle || 'Guided exercise'}`]
                }
                : {
                    summary: `Your baseline ROM is ${activePatient?.baselineRom || '--'}%.`,
                    details: ['Complete a tracked session to update progress and range of motion.']
                };
        }
        if (/start|begin/.test(question)) {
            return {
                summary: 'Start from today\'s session.',
                details: ['Tap Start Now from Today\'s Focus or Schedule.', 'Then press Start Rep Counter when your full body is in frame.']
            };
        }
        if (/done|complete|finished|skip|stop/.test(question)) {
            return {
                summary: 'You can stop when the set is complete or symptoms say to pause.',
                details: ['If you are stopping early, use End Session.', 'If you completed the reps, I will move you to the next exercise automatically.']
            };
        }
        if (/today|schedule|plan|session|exercise|exercises/.test(question)) {
            if (!today) return { summary: 'Your clinic plan is still being prepared.' };
            return {
                summary: `Today is Day ${today.day}: ${today.phase}.`,
                details: todayExercises.map((item, index) => `${index + 1}. ${item.title} - ${item.sets || `${item.targetReps || 10} reps`}`)
            };
        }
        return {
            summary: 'I can help - ask it another way.',
            details: [
                today ? `Today is Day ${today.day}, a ${today.phase} session.` : 'Your clinic plan is still being prepared.',
                exercise ? `Current focus: ${exercise.title}. You can ask about form, reps, rest, breathing, camera setup, or what is next.` : 'Ask about today, reps, form, progress, pain, rest, equipment, or what is next.'
            ]
        };
    }

    window.submitPatientAssistantQuestion = () => {
        window.togglePatientVoicePanel(true);
        const input = document.getElementById('patient-voice-question');
        const question = input?.value || '';
        const answer = answerPatientAssistantQuestion(question);
        if (input) input.value = '';
        updatePatientAssistant(answer, 'Answered out loud.', true, true);
    };

    window.startPatientAssistantListening = () => {
        window.togglePatientVoicePanel(true);
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            updatePatientAssistant('Voice questions are not supported in this browser. Type your question instead.', 'Mic unavailable.');
            return;
        }
        if (patientVoiceAssistant.listening) return;
        patientVoiceRecognition = new Recognition();
        patientVoiceRecognition.lang = 'en-US';
        patientVoiceRecognition.interimResults = false;
        patientVoiceRecognition.maxAlternatives = 1;
        patientVoiceAssistant.listening = true;
        updatePatientAssistant('Listening.', 'Listening...');
        patientVoiceRecognition.onresult = (event) => {
            const question = event.results?.[0]?.[0]?.transcript || '';
            const input = document.getElementById('patient-voice-question');
            if (input) input.value = question;
            updatePatientAssistant(answerPatientAssistantQuestion(question), 'Answered out loud.', true, true);
        };
        patientVoiceRecognition.onerror = () => {
            updatePatientAssistant('I could not hear that clearly. Try typing the question or tap Ask again.', 'Ready when you are.');
        };
        patientVoiceRecognition.onend = () => {
            patientVoiceAssistant.listening = false;
            const statusEl = document.getElementById('patient-voice-status');
            if (statusEl && statusEl.textContent === 'Listening...') statusEl.textContent = 'Ready when you are.';
        };
        try {
            patientVoiceRecognition.start();
        } catch (err) {
            patientVoiceAssistant.listening = false;
            updatePatientAssistant('I could not start the microphone. Type your question instead.', 'Mic unavailable.');
        }
    };

    function cuePatientRepProgress(reps, target) {
        const now = Date.now();
        if (now - patientVoiceAssistant.lastCueAt < 1600) return;
        let message = '';
        if (reps >= target) {
            message = 'Set complete. Nice control.';
        } else if (reps === 1) {
            message = 'First rep counted. Keep that same pace.';
        } else if (reps === Math.ceil(target / 2)) {
            message = 'Halfway there. Smooth and steady.';
        } else if (reps === target - 1) {
            message = 'One more controlled rep.';
        } else if (reps % 3 === 0) {
            message = `${reps} reps counted. Keep breathing.`;
        }
        if (!message) return;
        patientVoiceAssistant.lastCueAt = now;
        updatePatientAssistant(message, 'Coaching reps.', true);
    }

    function renderPatientSessionHistory(sessions = []) {
        if (!sessions.length) return '<div class="empty-state">No sessions completed yet.</div>';
        return sessions.slice().reverse().map(session => `
            <div class="patient-history-row">
                <strong>${escapeHtml(session.exerciseTitle || 'Guided exercise')}</strong>
                <span>${new Date(session.completedAt).toLocaleDateString()} - ${session.reps} reps - ${session.rom}% ROM - ${session.smoothness}% form</span>
            </div>
        `).join('');
    }

    function renderPatientProgressDetail(patient) {
        const sessions = patient.sessions || [];
        const baseline = Number(patient.baselineRom || 0);
        const target = Number(patient.targetRom || 100);
        const latest = sessions[sessions.length - 1];
        const latestRom = latest ? Number(latest.rom) : baseline;
        const progress = getPatientImprovement(patient);
        return `
            <div class="patient-progress-bar"><span style="width:${progress}%"></span></div>
            <div class="patient-progress-copy">
                <strong>${progress}% toward target ROM</strong>
                <span>Baseline ${baseline}% - Latest ${latestRom}% - Target ${target}%</span>
            </div>
            <div class="patient-session-history">${renderPatientSessionHistory(sessions)}</div>
        `;
    }

    function renderPatientMilestones(patient) {
        const sessions = patient.sessions || [];
        const progress = getPatientImprovement(patient);
        const totalReps = sessions.reduce((sum, session) => sum + Number(session.reps || 0), 0);
        const milestones = [
            { title: 'First session complete', done: sessions.length >= 1 },
            { title: 'Five sessions logged', done: sessions.length >= 5 },
            { title: '50 total reps completed', done: totalReps >= 50 },
            { title: 'Halfway to ROM goal', done: progress >= 50 },
            { title: 'Target ROM reached', done: progress >= 100 }
        ];
        return milestones.map(item => `
            <div class="patient-milestone ${item.done ? 'complete' : ''}">
                <strong>${item.done ? 'Complete' : 'Next'}</strong>
                <span>${item.title}</span>
            </div>
        `).join('');
    }

    window.runPatientMotionAnalysis = async () => {
        if (!activePatient || patientRepTracker?.active) return;
        if (!activeDailySession) {
            startTodaySession();
            if (!activeDailySession) return;
        }
        const video = document.getElementById('patient-motion-video');
        const state = document.getElementById('patient-motion-state');
        const result = document.getElementById('patient-motion-result');
        const exercise = activeDailySession.exercises?.[activeDailySession.index] || { title: 'Guided exercise', targetReps: 10 };
        const targetReps = Math.max(3, Math.min(30, Number(exercise.targetReps || 10)));
        try {
            if (typeof Pose === 'undefined') {
                throw new Error('Motion model unavailable');
            }
            result.classList.remove('danger');
            result.textContent = 'Camera starting. Move through one full comfortable rep to calibrate.';
            state.textContent = 'Starting camera...';
            patientMotionStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: patientMotionFacingMode },
                    width: { ideal: patientMotionWideCamera ? 1280 : 640 },
                    height: { ideal: patientMotionWideCamera ? 720 : 480 },
                    aspectRatio: { ideal: 16 / 9 }
                },
                audio: false
            });
            video.srcObject = patientMotionStream;
            await video.play();
            applyPatientMotionWideCamera(video, patientMotionWideCamera).catch(console.warn);
            updatePatientMotionWideButton();
            patientRepTracker = createPatientRepTracker(exercise, targetReps);
            document.getElementById('patient-live-reps').textContent = '0';
            document.getElementById('patient-live-target').textContent = String(targetReps);
            document.getElementById('patient-live-rom').textContent = '--';
            document.getElementById('patient-live-form').textContent = '--';
            document.getElementById('patient-motion-btn').style.display = 'none';
            document.getElementById('patient-motion-stop-btn').style.display = 'inline-flex';
            state.textContent = 'Tracking pose...';
            updatePatientAssistant(`I am watching for ${targetReps} controlled reps of ${exercise.title}. Start when ready.`, 'Tracking reps.', true);
            patientPose = new Pose({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`
            });
            patientPose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.55, minTrackingConfidence: 0.55 });
            patientPose.onResults(handlePatientPoseResults);
            patientCameraLoop = requestAnimationFrame(patientPoseFrame);
        } catch (err) {
            result.classList.add('danger');
            result.textContent = err.message === 'Motion model unavailable'
                ? 'The motion model did not load. Refresh and try again.'
                : 'Camera permission is required to capture motion analysis.';
            state.textContent = 'Camera unavailable';
            stopPatientMotionSession(false);
        }
    };

    function updatePatientMotionWideButton() {
        const btn = document.getElementById('patient-motion-wide-toggle');
        if (!btn) return;
        btn.classList.toggle('active', patientMotionWideCamera);
        btn.textContent = patientMotionWideCamera ? '1x' : '0.5x';
        btn.title = patientMotionWideCamera ? 'Standard view' : 'Wide angle';
        btn.setAttribute('aria-pressed', String(patientMotionWideCamera));
    }

    async function applyPatientMotionWideCamera(video, enabled) {
        const track = video?.srcObject?.getVideoTracks?.()[0];
        if (!track?.applyConstraints) return false;
        const capabilities = track.getCapabilities?.() || {};
        if (typeof capabilities.zoom === 'object') {
            const targetZoom = enabled
                ? capabilities.zoom.min
                : Math.min(Math.max(1, capabilities.zoom.min), capabilities.zoom.max);
            await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
            return true;
        }
        await track.applyConstraints({
            width: { ideal: enabled ? 1280 : 640 },
            height: { ideal: enabled ? 720 : 480 },
            aspectRatio: { ideal: 16 / 9 }
        });
        return false;
    }

    window.togglePatientMotionWideCamera = () => {
        patientMotionWideCamera = !patientMotionWideCamera;
        updatePatientMotionWideButton();
        const video = document.getElementById('patient-motion-video');
        if (patientMotionStream) {
            applyPatientMotionWideCamera(video, patientMotionWideCamera).catch(console.warn);
        }
    };

    window.flipPatientMotionCamera = () => {
        patientMotionFacingMode = patientMotionFacingMode === 'user' ? 'environment' : 'user';
        const wasActive = Boolean(patientRepTracker?.active);
        if (wasActive) {
            window.stopPatientMotionSession(false);
            window.runPatientMotionAnalysis();
        }
    };

    async function patientPoseFrame() {
        const video = document.getElementById('patient-motion-video');
        if (!patientRepTracker?.active || !patientPose || !video || video.readyState < 2) {
            if (patientRepTracker?.active) patientCameraLoop = requestAnimationFrame(patientPoseFrame);
            return;
        }
        await patientPose.send({ image: video });
        if (patientRepTracker?.active) patientCameraLoop = requestAnimationFrame(patientPoseFrame);
    }

    function createPatientRepTracker(exercise, targetReps) {
        return {
            active: true,
            exerciseTitle: exercise.title || 'Guided exercise',
            targetReps,
            reps: 0,
            phase: 'seeking-top',
            minSignal: Infinity,
            maxSignal: -Infinity,
            samples: [],
            repTimestamps: [],
            startedAt: Date.now(),
            lastRepAt: 0,
            formScores: []
        };
    }

    function handlePatientPoseResults(results) {
        const tracker = patientRepTracker;
        if (!tracker?.active) return;
        const video = document.getElementById('patient-motion-video');
        const canvas = document.getElementById('patient-motion-canvas');
        const ctx = canvas?.getContext('2d');
        if (canvas && video?.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
            if (results.poseLandmarks && typeof drawConnectors === 'function') {
                drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#7BC1B7', lineWidth: 4 });
                if (typeof drawLandmarks === 'function') {
                    drawLandmarks(ctx, results.poseLandmarks, { color: '#F59E0B', lineWidth: 2, radius: 3 });
                }
            }
        }
        if (!results.poseLandmarks) {
            document.getElementById('patient-motion-state').textContent = 'Step fully into frame';
            return;
        }
        const sample = getPatientMotionSample(results.poseLandmarks, activePatient?.plan?.protocolKey);
        if (!sample) {
            document.getElementById('patient-motion-state').textContent = 'Align shoulders and hips in frame';
            return;
        }
        updateRepTracker(sample);
    }

    function getPatientMotionSample(landmarks, protocolKey = 'general') {
        const side = (landmarks[12]?.visibility || 0) > (landmarks[11]?.visibility || 0) ? 'right' : 'left';
        const ids = side === 'right'
            ? { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 }
            : { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 };
        const shoulder = landmarks[ids.shoulder];
        const elbow = landmarks[ids.elbow];
        const wrist = landmarks[ids.wrist];
        const hip = landmarks[ids.hip];
        const knee = landmarks[ids.knee];
        const ankle = landmarks[ids.ankle];
        if ([shoulder, elbow, wrist, hip, knee, ankle].some(point => !point || point.visibility < 0.35)) return null;
        let signal;
        let angle;
        if (['knee', 'ankle', 'hip'].includes(protocolKey)) {
            angle = getAngle(hip, knee, ankle);
            signal = 180 - angle;
        } else if (['shoulder', 'neck'].includes(protocolKey)) {
            angle = getAngle(hip, shoulder, wrist);
            signal = Math.max(0, 180 - angle);
        } else if (protocolKey === 'back') {
            angle = getAngle(shoulder, hip, knee);
            signal = Math.abs(180 - angle);
        } else {
            angle = getAngle(shoulder, elbow, wrist);
            signal = 180 - angle;
        }
        const alignment = Math.abs((shoulder.x || 0) - (hip.x || 0));
        const form = Math.max(50, Math.min(100, Math.round(100 - alignment * 220)));
        return { signal: Math.max(0, signal), angle, form };
    }

    function getAngle(a, b, c) {
        const ab = { x: a.x - b.x, y: a.y - b.y };
        const cb = { x: c.x - b.x, y: c.y - b.y };
        const dot = ab.x * cb.x + ab.y * cb.y;
        const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
        return Math.round(Math.acos(Math.max(-1, Math.min(1, dot / Math.max(mag, 0.0001)))) * 180 / Math.PI);
    }

    function updateRepTracker(sample) {
        const tracker = patientRepTracker;
        tracker.samples.push(sample.signal);
        tracker.formScores.push(sample.form);
        tracker.minSignal = Math.min(tracker.minSignal, sample.signal);
        tracker.maxSignal = Math.max(tracker.maxSignal, sample.signal);
        const range = tracker.maxSignal - tracker.minSignal;
        const rom = Math.max(0, Math.min(100, Math.round(range * 2.2)));
        const avgForm = Math.round(tracker.formScores.slice(-20).reduce((sum, value) => sum + value, 0) / Math.min(20, tracker.formScores.length));
        document.getElementById('patient-live-rom').textContent = `${rom}%`;
        document.getElementById('patient-live-form').textContent = `${avgForm}%`;
        if (range < 10) {
            document.getElementById('patient-motion-state').textContent = 'Move through a larger comfortable range';
            return;
        }
        const low = tracker.minSignal + range * 0.35;
        const high = tracker.minSignal + range * 0.72;
        const now = Date.now();
        if (tracker.phase === 'seeking-top' && sample.signal >= high) {
            tracker.phase = 'seeking-bottom';
            document.getElementById('patient-motion-state').textContent = 'Good range. Return with control.';
        } else if (tracker.phase === 'seeking-bottom' && sample.signal <= low && now - tracker.lastRepAt > 700) {
            tracker.reps += 1;
            tracker.lastRepAt = now;
            tracker.repTimestamps.push(now);
            tracker.phase = 'seeking-top';
            document.getElementById('patient-live-reps').textContent = String(tracker.reps);
            showPatientRepGratification(tracker.reps, tracker.targetReps);
            cuePatientRepProgress(tracker.reps, tracker.targetReps);
            if (tracker.reps >= tracker.targetReps) completePatientMotionSession();
        } else {
            document.getElementById('patient-motion-state').textContent = `Tracking ${tracker.exerciseTitle}`;
        }
    }

    function showPatientRepGratification(reps, target) {
        const toast = document.getElementById('patient-rep-toast');
        toast.textContent = reps >= target ? 'Set complete' : `Rep ${reps} counted`;
        toast.classList.remove('show');
        void toast.offsetWidth;
        toast.classList.add('show');
        document.getElementById('patient-motion-result').textContent = reps >= target
            ? 'Target reached. Session complete.'
            : reps % 5 === 0
                ? 'Strong work. Keep the same controlled pace.'
                : 'Rep counted from motion tracking.';
    }

    async function completePatientMotionSession() {
        const tracker = patientRepTracker;
        if (!tracker) return;
        tracker.active = false;
        const sessions = activePatient.sessions || [];
        const lastRom = sessions.length ? Number(sessions[sessions.length - 1].rom) : Number(activePatient.baselineRom || 50);
        const target = Number(activePatient.targetRom || 90);
        const measuredRom = Math.max(0, Math.min(100, Math.round((tracker.maxSignal - tracker.minSignal) * 2.2)));
        const rom = Math.min(target, Math.max(lastRom, Math.round((lastRom * 0.65) + (measuredRom * 0.35))));
        const avgForm = Math.round(tracker.formScores.reduce((sum, value) => sum + value, 0) / Math.max(1, tracker.formScores.length));
        const session = {
            completedAt: new Date().toISOString(),
            rom,
            reps: tracker.reps,
            smoothness: avgForm,
            exerciseTitle: tracker.exerciseTitle,
            scheduleDay: activeDailySession?.day || null,
            sessionExerciseIndex: activeDailySession?.index ?? null
        };
        if (activeDailySession) {
            activeDailySession.completed[activeDailySession.index] = session;
            if (activeDailySession.index >= activeDailySession.exercises.length - 1) {
                session.dailySessionComplete = true;
            }
        }
        activePatient = {
            ...activePatient,
            sessions: [...sessions, session],
            updatedAt: new Date().toISOString()
        };
        await savePatientRecord(activePatient);
        await syncPatientSessionToCloud(activePatient, session);
        document.getElementById('patient-motion-result').textContent = `${session.exerciseTitle} complete: ${session.reps} tracked reps, ${session.rom}% ROM, ${session.smoothness}% form.`;
        updatePatientAssistant(`${session.exerciseTitle} complete. ${session.reps} reps logged with ${session.smoothness}% form.`, 'Set complete.', true);
        renderPatientDashboard();
        stopPatientMotionSession(false);
        if (activeDailySession && activeDailySession.index < activeDailySession.exercises.length - 1) {
            const nextIndex = activeDailySession.index + 1;
            startDailyExercise(nextIndex);
            window.switchPatientView('motion');
        } else {
            activeDailySession = null;
            renderDailySessionGuide();
            window.switchPatientView('progress');
        }
    }

    window.stopPatientMotionSession = (showMessage = true) => {
        if (patientCameraLoop) cancelAnimationFrame(patientCameraLoop);
        patientCameraLoop = null;
        if (patientMotionStream) patientMotionStream.getTracks().forEach(track => track.stop());
        patientMotionStream = null;
        patientPose = null;
        if (patientRepTracker) patientRepTracker.active = false;
        patientRepTracker = null;
        const video = document.getElementById('patient-motion-video');
        if (video) video.srcObject = null;
        const canvas = document.getElementById('patient-motion-canvas');
        const ctx = canvas?.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        document.getElementById('patient-motion-btn').style.display = 'inline-flex';
        document.getElementById('patient-motion-stop-btn').style.display = 'none';
        document.getElementById('patient-motion-state').textContent = 'Camera standby';
        if (showMessage) document.getElementById('patient-motion-result').textContent = 'Session ended.';
        if (showMessage) updatePatientAssistant('Session ended. You can restart when you are ready.', 'Ready when you are.', true);
    };

    async function syncPatientSessionToCloud(patient, latestSession) {
        if (!patient?.patientDocId) return;
        try {
            await setDoc(doc(db, 'patients', patient.patientDocId), {
                latestSession,
                sessionHistory: patient.sessions || [],
                updatedAt: patient.updatedAt || new Date().toISOString()
            }, { merge: true });
        } catch (err) {
            console.warn('Patient session cloud sync skipped:', err);
        }
    }

    function updateReportPreview() {
        if (!reportPreview) return;
        if (!lastScanData) {
            reportPreview.innerHTML = '<div class="empty-state">Complete a scan to populate the report preview.</div>';
            return;
        }
        const patient = Security.sanitize(patientNameInput?.value || 'Patient');
        const findings = lastScanData.issues.length ? lastScanData.issues.join(', ') : 'Healthy alignment detected';
        reportPreview.innerHTML = `
            <div class="report-preview-card">
                <div class="report-preview-header">
                    <div>
                        <h3>${clinicSettings.name || 'CyraxoHealth Clinic'}</h3>
                        <p class="muted">${patient} - ${new Date(lastScanData.timestamp).toLocaleDateString()}</p>
                    </div>
                    ${clinicSettings.logo ? `<img class="report-preview-logo" src="${clinicSettings.logo}" alt="Clinic logo">` : ''}
                </div>
                <div class="report-preview-grid">
                    <div class="report-preview-metric"><span>Overall</span><strong>${lastScanData.overall}/100</strong></div>
                    <div class="report-preview-metric"><span>Cervical</span><strong>${lastScanData.cervical}%</strong></div>
                    <div class="report-preview-metric"><span>Thoracic</span><strong>${lastScanData.thoracic}%</strong></div>
                    <div class="report-preview-metric"><span>Pelvic</span><strong>${lastScanData.pelvic}%</strong></div>
                </div>
                <p class="muted" style="margin-top:18px;"><strong>Findings:</strong> ${findings}</p>
            </div>
        `;
    }

    if (patientNameInput) patientNameInput.addEventListener('input', updateReportPreview);
    if (reportNotesInput) reportNotesInput.addEventListener('input', updateReportPreview);
    document.getElementById('patient-voice-question')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') window.submitPatientAssistantQuestion();
    });

    window.makeReport = () => {
        if (!lastScanData) {
            alert('Complete a posture scan before making a report.');
            return;
        }
        const patient = Security.sanitize(patientNameInput?.value || 'Patient');
        const filename = `${patient || 'patient'}-posture-progress-report`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const html = buildReportHtml(patient);
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${filename || 'posture-progress-report'}.html`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    function buildReportHtml(patient) {
        const notes = Security.phiScrub(Security.sanitize(reportNotesInput?.value || ''));
        const latest = lastScanData;
        const first = scanHistory[0] || latest;
        const delta = Number(latest.overall || 0) - Number(first.overall || 0);
        const findings = latest.issues.length ? latest.issues : ['Healthy alignment detected'];
        const exercises = latest.issues.map(issue => EXERCISE_DB[issue]).filter(Boolean);
        const exerciseRows = exercises.length ? exercises.map(ex => `
            <tr><td><strong>${ex.title}</strong><br><span>${ex.desc}</span></td><td>${ex.steps.join('<br>')}</td></tr>
        `).join('') : '<tr><td colspan="2">Maintain current program and repeat scan at the next check-in.</td></tr>';
        const historyRows = scanHistory.length ? scanHistory.map(record => `
            <tr><td>${new Date(record.timestamp).toLocaleDateString()}</td><td>${record.overall}/100</td><td>${record.cervical}%</td><td>${record.thoracic}%</td><td>${record.pelvic}%</td></tr>
        `).join('') : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Posture Progress Report - ${patient}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
<style>
:root {
    --primary: #0F766E;
    --accent: #4F46E5;
    --slate-50: #F8FAFC;
    --slate-100: #F1F5F9;
    --slate-200: #E2E8F0;
    --slate-700: #334155;
    --slate-900: #0F172A;
    --border: #E2E8F0;
}
body {
    margin: 0;
    background: #F8FAFC;
    color: var(--slate-700);
    font-family: 'Plus Jakarta Sans', sans-serif;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}
.page {
    max-width: 900px;
    margin: 40px auto;
    background: #FFFFFF;
    border-radius: 16px;
    box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.05), 0 8px 10px -6px rgba(15, 23, 42, 0.05);
    border: 1px solid var(--slate-200);
    overflow: hidden;
}
header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 32px;
    padding: 40px;
    background: linear-gradient(135deg, #0F766E 0%, #0D9488 100%);
    color: #FFFFFF;
}
header h1 {
    font-family: 'Outfit', sans-serif;
    font-size: 28px;
    font-weight: 800;
    margin: 0 0 6px 0;
    color: #FFFFFF;
    letter-spacing: -0.02em;
}
header p {
    margin: 0;
    color: #CCFBF1;
    font-size: 14px;
}
header .muted {
    color: #A7F3D0;
    font-size: 13px;
    margin-top: 4px;
}
.clinic-info {
    text-align: right;
}
.clinic-info h3 {
    font-family: 'Outfit', sans-serif;
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px 0;
    color: #FFFFFF;
}
.clinic-info p {
    color: #E2E8F0;
    font-size: 13px;
    margin: 2px 0 0 0;
}
.logo {
    max-width: 160px;
    max-height: 60px;
    object-fit: contain;
    margin-bottom: 10px;
    display: inline-block;
}
.section {
    padding: 36px 40px;
    border-bottom: 1px solid var(--slate-100);
    page-break-inside: avoid;
}
.section:last-of-type {
    border-bottom: none;
}
h2 {
    font-family: 'Outfit', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: var(--slate-900);
    margin: 0 0 16px 0;
    display: flex;
    align-items: center;
    gap: 8px;
}
h2::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 18px;
    background: var(--primary);
    border-radius: 2px;
}
.metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    background: var(--slate-50);
}
.metric {
    background: #FFFFFF;
    border: 1px solid var(--slate-200);
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
.metric span {
    color: var(--slate-700);
    display: block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 6px;
}
.metric strong {
    color: var(--primary);
    display: block;
    font-size: 26px;
    font-weight: 800;
    font-family: 'Outfit', sans-serif;
}
.summary-grid {
    display: grid;
    grid-template-columns: 1.2fr 0.8fr;
    gap: 32px;
    align-items: start;
}
.scan-container {
    background: var(--slate-50);
    border-radius: 12px;
    padding: 8px;
    border: 1px solid var(--slate-200);
}
.scan {
    width: 100%;
    border-radius: 8px;
    display: block;
    object-fit: cover;
}
ul {
    margin: 0;
    padding-left: 20px;
}
li {
    margin-bottom: 8px;
}
table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    font-size: 14px;
    border: 1px solid var(--slate-200);
    border-radius: 12px;
    overflow: hidden;
}
th {
    background: var(--slate-900);
    color: #FFFFFF;
    font-weight: 600;
    text-align: left;
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    letter-spacing: 0.02em;
}
th, td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--slate-200);
    border-right: 1px solid var(--slate-200);
    vertical-align: middle;
}
tr:last-child td {
    border-bottom: none;
}
th:last-child, td:last-child {
    border-right: none;
}
td strong {
    color: var(--slate-900);
}
td span {
    font-size: 12px;
    color: var(--slate-700);
}
footer {
    padding: 24px 40px;
    background: var(--slate-50);
    color: var(--slate-700);
    font-size: 12px;
    text-align: center;
    border-top: 1px solid var(--slate-200);
    line-height: 1.5;
}
@media print {
    body {
        background: #FFFFFF;
    }
    .page {
        margin: 0;
        border: none;
        box-shadow: none;
        max-width: 100%;
        width: 100%;
    }
    header {
        background: #0F766E !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    header h1, header h3 {
        color: #FFFFFF !important;
    }
    .metric {
        border: 1px solid var(--slate-200) !important;
        background: #FFFFFF !important;
    }
    .section {
        page-break-inside: avoid;
    }
}
@media (max-width: 768px) {
    .metrics {
        grid-template-columns: repeat(2, 1fr);
    }
    .summary-grid {
        grid-template-columns: 1fr;
    }
    header {
        flex-direction: column;
        align-items: flex-start;
        gap: 20px;
    }
    .clinic-info {
        text-align: left;
    }
}
</style>
</head>
<body>
<article class="page">
    <header>
        <div>
            <h1>Posture Progress Report</h1>
            <p><strong>${patient}</strong></p>
            <p class="muted">Generated ${new Date().toLocaleDateString()} - Scan ID ${latest.cyraxID}</p>
        </div>
        <div class="clinic-info">
            ${clinicSettings.logo ? `<img class="logo" src="${clinicSettings.logo}" alt="Clinic logo">` : ''}
            <h3>${clinicSettings.name || 'CyraxoHealth Clinic'}</h3>
            <p class="muted">${clinicSettings.contact || ''}</p>
            <p class="muted">${clinicSettings.address || ''}</p>
        </div>
    </header>
    <section class="section metrics">
        <div class="metric"><span>Overall</span><strong>${latest.overall}/100</strong></div>
        <div class="metric"><span>Cervical</span><strong>${latest.cervical}%</strong></div>
        <div class="metric"><span>Thoracic</span><strong>${latest.thoracic}%</strong></div>
        <div class="metric"><span>Pelvic</span><strong>${latest.pelvic}%</strong></div>
    </section>
    <section class="section summary-grid">
        <div>
            <h2>Clinical Summary</h2>
            <p>Latest score changed ${delta >= 0 ? '+' : ''}${delta} points from the first locally available scan.</p>
            <p>${notes || 'No additional clinician notes were added.'}</p>
            <h2 style="margin-top:24px;">Findings</h2>
            <ul>${findings.map(issue => `<li>${issue}</li>`).join('')}</ul>
        </div>
        ${latest.imageData ? `<div class="scan-container"><img class="scan" src="${latest.imageData}" alt="Analyzed posture scan"></div>` : ''}
    </section>
    <section class="section">
        <h2>Recommended Plan</h2>
        <table><thead><tr><th>Exercise</th><th>Instructions</th></tr></thead><tbody>${exerciseRows}</tbody></table>
    </section>
    <section class="section">
        <h2>Progress History</h2>
        <table><thead><tr><th>Date</th><th>Overall</th><th>Cervical</th><th>Thoracic</th><th>Pelvic</th></tr></thead><tbody>${historyRows}</tbody></table>
    </section>
    <footer>This report is generated from CyraxoHealth posture motion analysis and is intended to support clinical review. It does not replace clinician judgment.</footer>
</article>
</body>
</html>`;
    }
});
