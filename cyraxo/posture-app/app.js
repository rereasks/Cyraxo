import { CyraxoAIEngine } from './ai-engine.js';

document.addEventListener('DOMContentLoaded', async () => {
    let auth = { currentUser: null };
    let db = null;
    let onAuthStateChanged = (_auth, callback) => {
        callback(null);
        return () => {};
    };
    let doc = () => { throw new Error('Firebase is unavailable'); };
    let setDoc = async () => { throw new Error('Firebase is unavailable'); };
    let getDoc = async () => { throw new Error('Firebase is unavailable'); };
    let collection = () => { throw new Error('Firebase is unavailable'); };
    let query = () => { throw new Error('Firebase is unavailable'); };
    let where = () => { throw new Error('Firebase is unavailable'); };
    let getDocs = async () => { throw new Error('Firebase is unavailable'); };

    const firebaseLoadPromise = import('../portal/firebase-config.js');

    const applyFirebaseModule = (firebaseModule) => {
        ({
            auth,
            db,
            onAuthStateChanged,
            doc,
            setDoc,
            getDoc,
            collection,
            query,
            where,
            getDocs
        } = firebaseModule);
        return firebaseModule;
    };

    const ensureFirebaseLoaded = async () => applyFirebaseModule(await firebaseLoadPromise);

    try {
        applyFirebaseModule(await Promise.race([
            firebaseLoadPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase import timed out')), 1200))
        ]));
    } catch (err) {
        console.warn('Firebase module unavailable; local clinic mode remains active.', err);
    }

    // --- 1. CORE STATE ---
    const clinicCode = sessionStorage.getItem('clinic_code');
    let currentClinicId = clinicCode || 'DEMO-NODE';
    let currentClinicPlan = { tier: 'starter', limit: 5, activeCount: 0 };
    let clinicRosterPatients = [];
    let newPatientCustomExercises = [];
    const CLINIC_SETTINGS_KEY = 'cyrax_clinic_report_settings';
    let clinicReportSettings = {};
    let activeClinicReportPatient = null;
    
    // Initialize AI Engine
    window.ptAI = new CyraxoAIEngine();
    window.activeSchedulePatientCode = null;
    window.patientFacingMode = window.patientFacingMode || 'user';
    window.clinicFacingMode = window.clinicFacingMode || 'user';
    window.patientWideCamera = Boolean(window.patientWideCamera);
    window.clinicWideCamera = Boolean(window.clinicWideCamera);

    const updateWideCameraButton = (id, enabled) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', enabled);
        btn.innerText = enabled ? '1x' : '0.5x';
        btn.title = enabled ? 'Standard view' : 'Wide angle';
        btn.setAttribute('aria-pressed', String(enabled));
    };

    const applyWideCameraMode = async (videoElement, enabled) => {
        const stream = videoElement?.srcObject;
        const track = stream?.getVideoTracks?.()[0];
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
    };

    await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 800);
        onAuthStateChanged(auth, (user) => {
            if (user?.uid) currentClinicId = user.uid;
            if (user?.uid && new URLSearchParams(window.location.search).get('role') === 'clinic') {
                sessionStorage.setItem('cyrax_auth', 'true');
                sessionStorage.setItem('cyrax_role', 'clinic');
                sessionStorage.setItem('clinic_code', user.uid);
            }
            clearTimeout(fallback);
            resolve();
        });
    });

    const activeAuth = sessionStorage.getItem('cyrax_auth') === 'true';
    const activeRole = sessionStorage.getItem('cyrax_role');

    const clinicViewTitles = {
        dashboard: 'Summary Dashboard',
        patients: 'Patient Management',
        'clinic-reports': 'Reports',
        'clinic-schedule': 'Schedule Editor',
        analytics: 'Clinic Analytics',
        settings: 'Clinic Settings'
    };

    const appointmentTypes = {
        telehealth: { label: 'Telehealth Check-in', short: 'Telehealth', sub: 'Virtual Review', className: 'appointment-telehealth' },
        clinic: { label: 'In-Clinic Visit', short: 'In-Clinic', sub: 'Assessment', className: 'appointment-clinic' },
        lab: { label: 'Lab / Imaging', short: 'Lab / Imaging', sub: 'Diagnostics', className: 'appointment-lab' }
    };

    const planTiers = {
        starter: { label: 'Starter', limit: 5 },
        growth: { label: 'Growth', limit: 25 },
        enterprise: { label: 'Enterprise', limit: Infinity }
    };

    const parseLocalDate = (dateString) => {
        const [year, month, day] = dateString.split('-').map(Number);
        return new Date(year, month - 1, day);
    };

    const toDateInputValue = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const getScheduleStartDate = (data = {}) => {
        const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
        return new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate());
    };

    const getDateForScheduleDay = (data, day) => {
        const date = getScheduleStartDate(data);
        date.setDate(date.getDate() + day - 1);
        return date;
    };

    const getScheduleDayForDate = (data, dateString) => {
        const selected = parseLocalDate(dateString);
        const start = getScheduleStartDate(data);
        return Math.floor((selected - start) / 86400000) + 1;
    };

    const normalizeAppointment = (appointment, day, data) => {
        if (!appointment) return null;
        if (typeof appointment === 'string') {
            return {
                type: appointment,
                time: '',
                note: '',
                date: toDateInputValue(getDateForScheduleDay(data, Number(day)))
            };
        }
        return {
            type: appointment.type || 'telehealth',
            time: appointment.time || '',
            note: appointment.note || '',
            date: appointment.date || toDateInputValue(getDateForScheduleDay(data, Number(day)))
        };
    };

    const getVisitLabel = (type) => appointmentTypes[type]?.label || 'Scheduled Visit';
    const getVisitShortLabel = (type) => appointmentTypes[type]?.short || 'Visit';
    const getVisitSubtext = (type) => appointmentTypes[type]?.sub || 'Scheduled';
    const getAppointmentClass = (type) => appointmentTypes[type]?.className || 'appointment-telehealth';

    const formatScheduleDate = (dateString, options = { month: 'short', day: 'numeric' }) => {
        return parseLocalDate(dateString).toLocaleDateString(undefined, options);
    };

    const escapeHtml = (value = '') => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const escapeForInline = (value = '') => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

    const normalizeClinicKey = (value = '') => String(value).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');

    const getCurrentClinicId = () => currentClinicId || sessionStorage.getItem('clinic_code') || 'DEMO-NODE';

    const getActiveClinicKey = () => sessionStorage.getItem('clinic_key') || '';

    const hasCloudClinicSession = (clinicId = getCurrentClinicId()) => Boolean(auth.currentUser?.uid) || Boolean(getActiveClinicKey()) || clinicId === 'CYRAXO-TX-01';

    const getPatientDocId = (clinicId, code) => `${clinicId}_${code}`.replace(/[^A-Za-z0-9_-]/g, '_');

    const getPatientAccessDocId = (code) => String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const normalizeEmail = (email = '') => email.toLowerCase().trim();

    const encodeUtf8 = (value = '') => {
        if (window.TextEncoder) return new TextEncoder().encode(value);
        return Uint8Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0));
    };

    const sha256HexFallback = (value = '') => {
        const bytes = Array.from(encodeUtf8(value));
        const bitLength = bytes.length * 8;
        bytes.push(0x80);
        while ((bytes.length % 64) !== 56) bytes.push(0);
        for (let i = 7; i >= 0; i--) bytes.push((bitLength / (2 ** (i * 8))) & 0xff);

        const rightRotate = (num, bits) => (num >>> bits) | (num << (32 - bits));
        const constants = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

        for (let chunk = 0; chunk < bytes.length; chunk += 64) {
            const words = new Array(64);
            for (let i = 0; i < 16; i++) {
                const offset = chunk + i * 4;
                words[i] = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
            }
            for (let i = 16; i < 64; i++) {
                const s0 = rightRotate(words[i - 15], 7) ^ rightRotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
                const s1 = rightRotate(words[i - 2], 17) ^ rightRotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
                words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
            }
            let [a, b, c, d, e, f, g, h] = hash;
            for (let i = 0; i < 64; i++) {
                const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
                const ch = (e & f) ^ (~e & g);
                const temp1 = (h + s1 + ch + constants[i] + words[i]) >>> 0;
                const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (s0 + maj) >>> 0;
                h = g; g = f; f = e; e = (d + temp1) >>> 0;
                d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
            }
            [a, b, c, d, e, f, g, h].forEach((value, idx) => { hash[idx] = (hash[idx] + value) >>> 0; });
        }

        return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
    };

    const sha256Hex = async (value) => {
        if (!window.crypto?.subtle?.digest) return sha256HexFallback(value);
        const bytes = encodeUtf8(value);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };

    const createSalt = () => {
        const bytes = new Uint8Array(16);
        if (window.crypto?.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };

    const getPatientLoginDocId = async (email) => `login_${await sha256Hex(normalizeEmail(email))}`;

    const hashPatientPassword = (password, salt) => sha256Hex(`${salt}|${password}`);

    const getClinicPlanFromData = (clinicData = {}) => {
        const rawTier = (clinicData.ptPlan || clinicData.planTier || clinicData.tier || 'starter').toLowerCase();
        const tier = planTiers[rawTier] ? rawTier : 'starter';
        const configuredLimit = Number(clinicData.patientLimit || clinicData.ptPatientLimit);
        return {
            tier,
            label: planTiers[tier].label,
            limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : planTiers[tier].limit,
            activeCount: currentClinicPlan.activeCount || 0
        };
    };

    const updatePlanStatus = () => {
        const status = document.getElementById('patient-plan-status');
        if (!status) return;
        const limitText = currentClinicPlan.limit === Infinity ? 'Unlimited' : currentClinicPlan.limit;
        status.innerHTML = `<strong>${currentClinicPlan.label}</strong> plan · ${currentClinicPlan.activeCount}/${limitText} active patients`;
    };

    const loadClinicPlan = async () => {
        currentClinicPlan = { ...currentClinicPlan, ...planTiers.starter, tier: 'starter', label: 'Starter' };
        try {
            const clinicSnap = await getDoc(doc(db, 'clinics', getCurrentClinicId()));
            if (clinicSnap.exists()) currentClinicPlan = getClinicPlanFromData(clinicSnap.data());
        } catch (err) {
            console.warn('Clinic plan lookup skipped:', err);
        }
        updatePlanStatus();
    };

    const canAddPatient = () => currentClinicPlan.limit === Infinity || currentClinicPlan.activeCount < currentClinicPlan.limit;

    const getInjuryCategory = (injury = '') => {
        const iLower = injury.toLowerCase();
        if (iLower.includes('knee') || iLower.includes('acl')) return 'knee';
        if (iLower.includes('sciatica') || iLower.includes('disc')) return 'sciatica';
        return 'shoulder';
    };

    const buildPatientRow = (patient) => {
        const code = patient.code;
        const externalPatientId = escapeHtml(patient.externalPatientId || 'Not assigned');
        const injury = escapeHtml(patient.injury || 'Clinical Recovery Plan');
        const injuryCat = getInjuryCategory(patient.injury || '');
        const status = patient.status || 'Active';
        const statusClass = status === 'Archived' ? 'archived' : 'success';
        const history = getSessionHistory(patient);
        const latest = getLatestSession(patient);
        const latestText = latest ? `${latest.romPercent}% ROM · ${latest.reps} reps${latest.verificationStatus ? ` · ${latest.verificationStatus}` : ''}` : 'No sessions';
        const lastSeen = latest?.completedAt ? new Date(latest.completedAt).toLocaleDateString() : 'Pending';
        const progressScore = getPatientProgressScore(patient);
        return `
            <td style="font-weight: 600; color: var(--primary);">#PX-${code}</td>
            <td>${externalPatientId}</td>
            <td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td>
            <td>${injury}</td>
            <td>${history.length}</td>
            <td>${escapeHtml(latestText)}<span class="table-subtext">${escapeHtml(lastSeen)}</span></td>
            <td><div class="mini-progress"><span style="width:${progressScore}%;"></span></div><span class="table-subtext">${progressScore}% adherence</span></td>
            <td><div class="row-actions"><button class="btn btn-secondary" style="padding: 8px 16px; font-size: 0.8rem;" onclick="openClinicReport('${injuryCat}', '${code}')">Review</button><button class="btn" style="padding: 8px 14px; font-size: 0.8rem;" onclick="editPatientSchedule('${code}')">Schedule</button><button class="btn btn-danger" style="padding: 8px 14px; font-size: 0.8rem;" onclick="removePatient('${code}')">Remove</button></div></td>
        `;
    };

    const renderEmptyRoster = () => {
        const tbody = document.getElementById('patient-list-body');
        if (!tbody || tbody.children.length > 0) return;
        tbody.innerHTML = `
            <tr class="empty-roster-row">
                <td colspan="8" style="text-align:center; color: var(--text-muted); padding: 28px;">No active patients yet. Register a patient to generate an access code.</td>
            </tr>
        `;
    };

    const renderClinicReportList = () => {
        const list = document.getElementById('clinic-report-list');
        if (!list) return;
        const patients = clinicRosterPatients.filter((patient) => patient?.code && patient.status !== 'Archived');
        list.innerHTML = patients.length ? patients.map((patient) => {
            const history = getSessionHistory(patient);
            const latest = getLatestSession(patient);
            const latestText = latest
                ? `${latest.exerciseTitle || 'Latest session'} · ${latest.romPercent ?? '--'}% ROM · ${latest.reps ?? '--'} reps`
                : 'No synced sessions yet';
            return `
                <div class="exercise-card report-patient-card" style="align-items: flex-start;">
                    <div class="ex-info">
                        <h4>#PX-${escapeHtml(patient.code)} · ${escapeHtml(patient.externalPatientId || 'Patient')}</h4>
                        <p>${escapeHtml(patient.injury || 'Clinical Recovery Plan')}</p>
                        <div class="report-session-meta">
                            <span>${history.length} synced sessions</span>
                            <span>${escapeHtml(latestText)}</span>
                        </div>
                        <div class="row-actions" style="margin-top: 12px;">
                            <button class="btn" style="padding: 8px 14px; font-size: 0.82rem;" onclick="openClinicReport('${getInjuryCategory(patient.injury || '')}', '${escapeForInline(patient.code)}')">Review / Download</button>
                            <button class="btn btn-secondary" style="padding: 8px 14px; font-size: 0.82rem;" onclick="editPatientSchedule('${escapeForInline(patient.code)}')">Schedule</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('') : '<p style="color: var(--text-muted);">No active patients yet. Register a patient to generate a report.</p>';
    };

    const renderClinicSessionReview = (patientData = {}) => {
        const list = document.getElementById('clinic-session-review-list');
        if (!list) return;
        const history = getSessionHistory(patientData);
        if (!history.length) {
            list.innerHTML = '<div class="empty-schedule">No home sessions have synced yet.</div>';
            return;
        }
        list.innerHTML = history.slice(0, 12).map((session) => {
            const status = String(session.verificationStatus || session.geminiVerification?.agreement || 'review').toLowerCase();
            const confidence = session.verificationConfidence ?? session.geminiVerification?.confidence ?? session.kinematicConfidence ?? '--';
            const note = session.geminiVerification?.notes || session.kinematicFlags?.join(', ') || 'No verification notes recorded.';
            const flags = [
                session.mask,
                ...(Array.isArray(session.kinematicFlags) ? session.kinematicFlags : []),
                ...(Array.isArray(session.geminiVerification?.flags) ? session.geminiVerification.flags : [])
            ].filter(Boolean);
            return `
                <article class="clinic-session-card">
                    <div class="clinic-session-card-head">
                        <div>
                            <h5>${escapeHtml(session.exerciseTitle || 'Guided Session')}</h5>
                            <small>${escapeHtml(new Date(session.completedAt || Date.now()).toLocaleString())}</small>
                        </div>
                        <span class="verification-badge ${escapeHtml(status)}">${escapeHtml(status)} · ${escapeHtml(String(confidence))}%</span>
                    </div>
                    <div class="clinic-session-metrics">
                        <span><strong>${escapeHtml(String(session.romPercent ?? '--'))}%</strong>ROM</span>
                        <span><strong>${escapeHtml(String(session.reps ?? '--'))}</strong>Reps</span>
                        <span><strong>${escapeHtml(String(session.trackingQuality ?? '--'))}%</strong>Tracking</span>
                        <span><strong>${escapeHtml(String(session.kinematicConsistency ?? session.smoothness ?? '--'))}%</strong>Consistency</span>
                    </div>
                    <p class="clinic-session-note">${escapeHtml(note)}${flags.length ? ` Flags: ${escapeHtml(flags.join(' · '))}` : ''}</p>
                </article>
            `;
        }).join('');
    };

    const getPatientSortableValue = (patient = {}, key = '') => {
        if (key === 'injury') return (patient.injury || '').toLowerCase();
        if (key === 'external-id') return (patient.externalPatientId || '').toLowerCase();
        if (key === 'code') return (patient.code || '').toLowerCase();
        if (key === 'latest') return new Date(getLatestSession(patient)?.completedAt || 0).getTime();
        if (key === 'progress') return getPatientProgressScore(patient);
        return new Date(patient.createdAt || 0).getTime();
    };

    const sortPatientsForRoster = (patients = []) => {
        const sortValue = document.getElementById('patient-roster-sort')?.value || 'created-desc';
        const direction = sortValue.endsWith('-asc') ? 'asc' : 'desc';
        const key = sortValue.replace(/-(asc|desc)$/, '');
        const multiplier = direction === 'asc' ? 1 : -1;
        return [...patients].sort((a, b) => {
            const aValue = getPatientSortableValue(a, key);
            const bValue = getPatientSortableValue(b, key);
            if (typeof aValue === 'number' && typeof bValue === 'number') return (aValue - bValue) * multiplier;
            return String(aValue).localeCompare(String(bValue)) * multiplier;
        });
    };

    const matchesPatientRosterSearch = (patient = {}, searchTerm = '') => {
        if (!searchTerm) return true;
        const latest = getLatestSession(patient);
        const searchText = [
            patient.code,
            patient.externalPatientId,
            patient.injury,
            patient.status,
            patient.intensity,
            latest?.exerciseTitle,
            latest?.completedAt
        ].filter(Boolean).join(' ').toLowerCase();
        return searchText.includes(searchTerm);
    };

    const renderPatientRoster = () => {
        const tbody = document.getElementById('patient-list-body');
        if (!tbody) return;
        const searchTerm = (document.getElementById('patient-roster-search')?.value || '').trim().toLowerCase();
        const visiblePatients = sortPatientsForRoster(
            clinicRosterPatients.filter((patient) => matchesPatientRosterSearch(patient, searchTerm))
        );
        tbody.innerHTML = '';
        visiblePatients.forEach((patient) => {
            const row = document.createElement('tr');
            row.setAttribute('data-px-code', patient.code);
            row.innerHTML = buildPatientRow(patient);
            tbody.appendChild(row);
        });
        if (!visiblePatients.length) {
            tbody.innerHTML = `
                <tr class="empty-roster-row">
                    <td colspan="8" style="text-align:center; color: var(--text-muted); padding: 28px;">${searchTerm ? 'No patients match that search.' : 'No active patients yet. Register a patient to generate an access code.'}</td>
                </tr>
            `;
        }
        renderClinicReportList();
    };

    const setClinicRosterPatients = (patients = []) => {
        const byCode = new Map();
        patients
            .filter((patient) => patient?.code && patient.status !== 'Archived' && patient.recordType !== 'patientLogin')
            .forEach((patient) => byCode.set(patient.code, { ...(byCode.get(patient.code) || {}), ...patient }));
        clinicRosterPatients = Array.from(byCode.values());
        currentClinicPlan.activeCount = clinicRosterPatients.length;
        updatePlanStatus();
        renderPatientRoster();
        renderClinicReportList();
    };

    const upsertPatientRow = (patient, prepend = true) => {
        if (!patient?.code || patient.status === 'Archived') return;
        const withoutPatient = clinicRosterPatients.filter((item) => item.code !== patient.code);
        clinicRosterPatients = prepend ? [patient, ...withoutPatient] : [...withoutPatient, patient];
        currentClinicPlan.activeCount = clinicRosterPatients.length;
        updatePlanStatus();
        renderPatientRoster();
    };

    const savePatientToFirestore = async (patientData) => {
        const { _patientDocId, _fromFirestore, ...firestorePatientData } = patientData || {};
        const clinicId = patientData.clinicId || auth.currentUser?.uid || getCurrentClinicId();
        if (!hasCloudClinicSession(clinicId)) {
            console.info('Patient cloud sync skipped: clinic is using local demo access.');
            return false;
        }
        const patientRef = doc(db, 'patients', getPatientDocId(clinicId, patientData.code));
        await setDoc(patientRef, {
            ...firestorePatientData,
            clinicId,
            clinicKey: getActiveClinicKey(),
            clinicPatientKey: getPatientDocId(clinicId, patientData.code),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        await setDoc(doc(db, 'patient_access', getPatientAccessDocId(patientData.code)), {
            code: patientData.code,
            clinicId,
            clinicKey: getActiveClinicKey(),
            externalPatientId: patientData.externalPatientId || '',
            patientDocId: getPatientDocId(clinicId, patientData.code),
            status: patientData.status || 'Active',
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return true;
    };

    const readJsonStorage = (key, fallback = null) => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    };

    const loadClinicReportSettings = async () => {
        clinicReportSettings = readJsonStorage(CLINIC_SETTINGS_KEY, {});
        
        // Fetch dynamically from Firestore if online and configured
        const clinicId = getCurrentClinicId();
        if (clinicId && clinicId !== 'DEMO-NODE' && clinicId !== 'CYRAXO-TX-01') {
            try {
                const clinicDocRef = doc(db, 'clinics', clinicId);
                const clinicSnap = await getDoc(clinicDocRef);
                if (clinicSnap.exists()) {
                    const data = clinicSnap.data();
                    if (data.clinicSettings) {
                        clinicReportSettings = { ...clinicReportSettings, ...data.clinicSettings };
                        localStorage.setItem(CLINIC_SETTINGS_KEY, JSON.stringify(clinicReportSettings));
                    }
                }
            } catch (err) {
                console.warn('Clinic settings background fetch skipped:', err);
            }
        }

        clinicReportSettings.name = clinicReportSettings.name || sessionStorage.getItem('clinic_name') || getCurrentClinicId();
        clinicReportSettings.contact = clinicReportSettings.contact || '';
        const nameInput = document.getElementById('clinic-report-name');
        const contactInput = document.getElementById('clinic-report-contact');
        const logoPreview = document.getElementById('clinic-report-logo-preview');
        if (nameInput) nameInput.value = clinicReportSettings.name || '';
        if (contactInput) contactInput.value = clinicReportSettings.contact || '';
        if (logoPreview) {
            logoPreview.innerHTML = clinicReportSettings.logo
                ? `<img src="${clinicReportSettings.logo}" alt="Clinic logo" style="max-width: 90%; max-height: 64px; object-fit: contain;">`
                : 'No logo uploaded';
        }
    };

    const saveClinicReportSettingsToStorage = () => {
        localStorage.setItem(CLINIC_SETTINGS_KEY, JSON.stringify(clinicReportSettings));
    };

    loadClinicReportSettings();

    const isPermissionError = (err) => {
        const message = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
        return message.includes('permission') || message.includes('insufficient');
    };

    const cachePrescription = (patientData) => {
        if (!patientData?.code) return;
        const { _patientDocId, _fromFirestore, ...cacheablePatientData } = patientData;
        localStorage.setItem(`prescription_${patientData.code}`, JSON.stringify(cacheablePatientData));
    };

    const getCachedPrescription = (code) => readJsonStorage(`prescription_${code}`, null);

    const getExerciseInstructions = (exercise = {}) => {
        if (Array.isArray(exercise.steps) && exercise.steps.length > 0) return exercise.steps;
        const title = (exercise.title || '').toLowerCase();
        const description = (exercise.description || '').toLowerCase();
        const text = `${title} ${description}`;
        const titled = exercise.title || 'this exercise';
        const instructionLibrary = [
            { match: ["wall angel"], steps: ["Stand with your back flat against a wall and feet 6-12 inches forward.", "Tuck your ribs down so the low back stays close to the wall.", "Slide elbows and wrists upward like a snow angel without shrugging.", "Stop before the wrists lift off the wall, then slide back down with control."] },
            { match: ["scapular"], steps: ["Stand or sit tall with arms relaxed by your sides.", "Draw both shoulder blades gently down and back as if pinching a pencil.", "Keep your ribs stacked and avoid arching the low back.", "Hold for 3 seconds, then release slowly before the next rep."] },
            { match: ["external rotation", "internal rotation", "rotator cuff", "shoulder rotation"], steps: ["Anchor a light band at elbow height and stand side-on to the anchor.", "Keep the working elbow bent to 90 degrees and tucked against a towel at your ribs.", "Rotate the forearm against the band while the upper arm stays still.", "Pause at the end range, then return slowly without letting the shoulder roll forward."] },
            { match: ["pendulum"], steps: ["Lean forward with your non-working hand supported on a table or chair.", "Let the involved arm hang loose toward the floor.", "Use gentle body weight shifts to make small circles with the relaxed arm.", "Keep the motion pain-free and avoid actively lifting the shoulder."] },
            { match: ["sleeper"], steps: ["Lie on the involved side with that shoulder and elbow bent to 90 degrees.", "Keep the shoulder blade gently set against the floor or table.", "Use the opposite hand to guide the forearm downward until you feel a mild stretch.", "Hold without pain, then release slowly back to the starting angle."] },
            { match: ["heel slide"], steps: ["Lie on your back with both legs straight or sit with the heel on a smooth surface.", "Slide the working heel toward your glutes while keeping the heel in contact with the surface.", "Pause when you feel a gentle knee stretch or reach your comfortable limit.", "Slide the heel back out slowly until the knee is straight again."] },
            { match: ["straight leg"], steps: ["Lie on your back with the working leg straight and the other knee bent.", "Tighten the front thigh so the working knee stays locked straight.", "Lift the straight leg about 12 inches without letting the knee bend.", "Lower slowly to the surface and reset the thigh before the next rep."] },
            { match: ["terminal knee", "terminal"], steps: ["Loop a resistance band behind the working knee and anchor it securely.", "Start with the knee slightly bent and weight balanced through the foot.", "Push the knee backward until the leg straightens and the quad tightens.", "Hold briefly, then let the knee bend forward with control."] },
            { match: ["wall slide", "wall squat"], steps: ["Stand with your back against a wall and feet hip-width apart.", "Slide down only as far as comfortable while keeping knees tracking over toes.", "Pause with weight through the heels and trunk upright.", "Press through both feet to slide back up to standing."] },
            { match: ["calf raise"], steps: ["Stand tall with fingertips on a wall, counter, or chair for balance.", "Keep knees straight but not locked and lift both heels off the floor.", "Pause at the top while staying centered over the big toe and second toe.", "Lower the heels slowly until they touch the floor before repeating."] },
            { match: ["press-up", "press up"], steps: ["Lie on your stomach with hands under your shoulders.", "Relax your hips and legs into the floor.", "Press your chest upward with your arms while your hips stay down.", "Lower back to the floor slowly and stop if symptoms travel farther down the leg."] },
            { match: ["bird-dog", "bird dog"], steps: ["Start on hands and knees with hands under shoulders and knees under hips.", "Brace your core so the low back stays level.", "Reach one arm forward and the opposite leg back without rotating the hips.", "Hold briefly, return with control, then switch sides."] },
            { match: ["nerve glide", "sciatic"], steps: ["Sit tall near the edge of a chair with the involved knee bent.", "Slowly straighten the knee until you feel gentle nerve tension, not pain.", "Point and flex the ankle gently while keeping the motion small.", "Bend the knee again before symptoms increase or linger."] },
            { match: ["piriformis"], steps: ["Lie on your back with both knees bent.", "Cross the involved ankle over the opposite knee to make a figure-four shape.", "Pull the uncrossed thigh toward your chest until you feel a glute stretch.", "Hold the stretch while breathing, then release slowly."] },
            { match: ["pelvic"], steps: ["Lie on your back with knees bent and feet flat.", "Gently flatten your low back toward the floor by tightening the lower abdominals.", "Hold for 5 seconds while breathing normally.", "Relax back to neutral without lifting the hips."] },
            { match: ["bridge"], steps: ["Lie on your back with knees bent and feet hip-width apart.", "Squeeze your glutes and brace your core before lifting.", "Lift hips until shoulders, hips, and knees form a straight line.", "Lower slowly one segment at a time without dropping."] },
            { match: ["wrist extensor stretch"], steps: ["Extend the involved arm in front of you with palm facing down.", "Keep the elbow straight and shoulder relaxed.", "Use the other hand to bend the wrist and fingers downward.", "Hold a gentle stretch along the outer forearm, then release slowly."] },
            { match: ["eccentric wrist"], steps: ["Rest the forearm on a table with the wrist just past the edge and palm down.", "Use the other hand to help lift the wrist up.", "Let go and lower the wrist slowly against a light weight.", "Reset with help from the other hand before the next rep."] },
            { match: ["pronation", "supination"], steps: ["Sit with elbow bent to 90 degrees and tucked by your side.", "Hold a light hammer, dowel, or small weight vertically.", "Rotate the forearm until the palm faces up, then slowly until it faces down.", "Keep the elbow pinned to your side throughout the motion."] },
            { match: ["towel twist"], steps: ["Hold a rolled towel horizontally with both hands in front of you.", "Twist one hand forward and the other backward like wringing out water.", "Keep shoulders relaxed and elbows close to your ribs.", "Reverse the twist slowly and repeat in both directions."] },
            { match: ["finger extension"], steps: ["Place a rubber band around the tips of your fingers and thumb.", "Start with fingertips touching lightly.", "Open the fingers outward against the band without bending the wrist.", "Pause briefly, then close the fingers slowly."] },
            { match: ["calf stretch"], steps: ["Stand facing a wall with the involved leg behind you.", "Keep the back heel flat and toes pointing forward.", "Lean your hips toward the wall until you feel a calf stretch.", "Hold without bouncing, then switch sides if prescribed."] },
            { match: ["toe curl"], steps: ["Sit with the foot flat on a towel spread across the floor.", "Curl the toes to pull the towel toward your arch.", "Keep the heel down and avoid gripping with the whole leg.", "Relax the toes and repeat until the towel gathers under the foot."] },
            { match: ["plantar fascia massage"], steps: ["Sit or stand with a ball or frozen water bottle under the involved foot.", "Apply gentle pressure through the arch.", "Roll from heel to ball of the foot in slow passes.", "Avoid pressing directly into sharp pain or numbness."] },
            { match: ["ankle alphabet"], steps: ["Sit with the involved foot lifted just off the floor.", "Use the big toe as a pointer.", "Draw each letter of the alphabet slowly from the ankle.", "Keep the knee and hip still so the motion comes from the ankle."] },
            { match: ["heel drop"], steps: ["Stand on a step with the balls of both feet on the edge and heels free.", "Rise up using both feet and shift more weight to the involved side if tolerated.", "Lower the heel below step level slowly over 3-5 seconds.", "Use both feet to return to the top before repeating."] },
            { match: ["chin tuck", "cervical retraction"], steps: ["Sit or stand tall with eyes level.", "Slide your head straight backward as if making a double chin.", "Keep the jaw relaxed and do not look down.", "Hold briefly, then return to neutral with control."] },
            { match: ["trapezius", "levator"], steps: ["Sit tall and hold the chair lightly with the hand on the stretching side.", "Tilt your head away from the tight side until you feel a neck stretch.", "For levator stretch, turn your nose slightly toward the opposite armpit.", "Breathe slowly and keep the shoulder down throughout the hold."] },
            { match: ["isometric"], steps: ["Set the target joint in a comfortable mid-range position.", "Press gently into your hand, a wall, or a stable surface without allowing movement.", "Build pressure to a mild-to-moderate effort and hold while breathing.", "Relax fully for a few seconds before the next hold."] },
            { match: ["mobility"], steps: [`Set up comfortably for ${titled} with the affected area supported.`, "Move slowly into the first comfortable direction until you feel mild tension.", "Pause for one breath without forcing the range.", "Return to neutral and repeat with smooth, pain-free motion."] },
            { match: ["tissue decompression", "decompression"], steps: [`Position yourself so the sore area for ${titled} is relaxed and supported.`, "Take a slow breath in and gently lengthen through the target area.", "Exhale and let surrounding muscles soften without forcing a stretch.", "Repeat for the prescribed breaths, keeping symptoms calm."] },
            { match: ["eccentric", "loading"], steps: [`Start ${titled} at the top of the prescribed motion with light support available.`, "Lower through the working phase slowly over 3-5 seconds.", "Keep alignment steady and stop before sharp pain.", "Use assistance to reset to the start position, then repeat."] },
            { match: ["active recovery", "flow"], steps: [`Begin ${titled} in a relaxed stance or seated position.`, "Move through the listed joints in a slow, continuous pattern.", "Keep each movement easy enough that breathing stays steady.", "Cycle through the flow for the prescribed time without pushing into pain."] }
        ];

        const found = instructionLibrary.find(({ match }) => match.some(term => text.includes(term)));
        if (found) return found.steps;

        return [
            `Set up for ${titled} in a stable, comfortable position with the target area supported.`,
            `Perform the main ${titled} movement slowly through a pain-free range.`,
            "Pause briefly at the end of the motion while keeping nearby joints aligned.",
            "Return to the starting position with control and reset before the next rep."
        ];
    };

    const normalizeExercise = (exercise = {}, index = 0) => {
        const normalized = {
            id: exercise.id || index + 1,
            title: exercise.title || `Exercise ${index + 1}`,
            duration: exercise.duration || 'As prescribed',
            icon: exercise.icon || '+',
            description: exercise.description || 'Move slowly and stay within a comfortable range.',
            ...exercise
        };
        normalized.steps = getExerciseInstructions(normalized);
        return normalized;
    };

    const getPatientExerciseLibrary = (data = {}) => {
        const fallbackExercises = [
            { id: 'clinic-mobility', title: 'Clinic Mobility Drill', duration: '2 sets of 10', description: 'Controlled mobility work assigned by the clinic.' },
            { id: 'clinic-isometric', title: 'Clinic Isometric Hold', duration: '5 holds of 10 seconds', description: 'Low-load activation with stable positioning.' },
            { id: 'clinic-balance', title: 'Clinic Balance Control', duration: '3 rounds of 30 seconds', description: 'Postural control and stability training.' }
        ];
        return [
            ...(Array.isArray(data.exercises) ? data.exercises : []),
            ...(Array.isArray(data.customExercises) ? data.customExercises : []),
            ...fallbackExercises
        ]
            .filter((exercise) => exercise?.title)
            .map(normalizeExercise)
            .filter((exercise, index, list) => list.findIndex((item) => item.title === exercise.title) === index);
    };

    const getDefaultDailyExercises = (dayNum, exercises = []) => {
        const normalized = exercises.map(normalizeExercise);
        if (!normalized.length) return [];
        if (dayNum % 4 === 0) return [];
        if (normalized.length <= 2) return normalized;
        const pattern = dayNum % 4;
        if (pattern === 1) return [normalized[0], normalized[1], normalized[2] || normalized[0]];
        if (pattern === 2) return [normalized[normalized.length - 1], normalized[normalized.length - 2], normalized[0]];
        return normalized;
    };

    const getScheduledExercisesForDay = (data = {}, dayNum) => {
        const explicit = data.dailyExercises?.[dayNum] || data.dailyExercises?.[String(dayNum)];
        if (Array.isArray(explicit)) return explicit.map(normalizeExercise);
        return getDefaultDailyExercises(dayNum, data.exercises || []);
    };

    const getCurrentScheduleDay = (data = {}) => {
        const totalDays = Math.max(1, (parseInt(data.timeline) || 4) * 7);
        const elapsed = Math.floor((Date.now() - getScheduleStartDate(data).getTime()) / 86400000) + 1;
        return clamp(elapsed, 1, totalDays);
    };

    const renderCustomExerciseDrafts = () => {
        const list = document.getElementById('reg-custom-ex-list');
        if (!list) return;
        list.innerHTML = newPatientCustomExercises.length
            ? newPatientCustomExercises.map((exercise, index) => `
                <div class="custom-exercise-item">
                    <div>
                        <strong>${escapeHtml(exercise.title)}</strong>
                        <span>${escapeHtml(exercise.sets || exercise.duration || 'Clinic assigned')} · ${escapeHtml(exercise.detail || exercise.cue || 'No extra cue')}</span>
                    </div>
                    <button class="btn btn-secondary" type="button" onclick="removeCustomExerciseFromNewPatient(${index})">Remove</button>
                </div>
            `).join('')
            : '<div class="empty-schedule">No custom exercises added.</div>';
    };

    window.addCustomExerciseToNewPatient = () => {
        const titleInput = document.getElementById('reg-custom-ex-title');
        const setsInput = document.getElementById('reg-custom-ex-sets');
        const detailInput = document.getElementById('reg-custom-ex-detail');
        const title = Security.sanitize(titleInput?.value || '');
        const sets = Security.sanitize(setsInput?.value || '');
        const detail = Security.sanitize(detailInput?.value || '');
        if (!title) {
            alert('Enter an exercise name first.');
            return;
        }
        newPatientCustomExercises.push(normalizeExercise({
            id: `custom-${Date.now()}`,
            title,
            sets: sets || 'Clinic assigned',
            duration: sets || 'As prescribed',
            description: detail || 'Clinic-specific exercise.',
            detail: detail || 'Clinic-specific exercise.',
            cue: detail || 'Move with controlled form.'
        }, newPatientCustomExercises.length));
        if (titleInput) titleInput.value = '';
        if (setsInput) setsInput.value = '';
        if (detailInput) detailInput.value = '';
        renderCustomExerciseDrafts();
    };

    window.removeCustomExerciseFromNewPatient = (index) => {
        newPatientCustomExercises.splice(index, 1);
        renderCustomExerciseDrafts();
    };

    const loadClinicPatients = async () => {
        const tbody = document.getElementById('patient-list-body');
        if (!tbody) return;
        const clinicId = getCurrentClinicId();

        const localPatients = Object.keys(localStorage)
            .filter((key) => key.startsWith('prescription_'))
            .map((key) => {
                return readJsonStorage(key, null);
            })
            .filter((patient) => patient?.code && patient.clinicId === clinicId && patient.recordType !== 'patientLogin')
            .filter((patient) => patient.status !== 'Archived')
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        setClinicRosterPatients(localPatients);
        localPatients.forEach((patient) => {
            savePatientToFirestore(patient).catch((err) => console.warn('Local patient cloud migration skipped:', err));
        });

        try {
            const q = query(collection(db, 'patients'), where('clinicId', '==', clinicId));
            const querySnapshot = await getDocs(q);
            const patients = [];
            querySnapshot.forEach((snap) => patients.push(snap.data()));
            const activePatients = patients.filter((patient) => patient.status !== 'Archived' && patient.recordType !== 'patientLogin');
            activePatients.forEach((patient) => {
                cachePrescription(patient);
            });
            setClinicRosterPatients([...localPatients, ...activePatients]);
        } catch (err) {
            console.warn('Patient roster sync skipped:', err);
        }
        renderEmptyRoster();
    };

    const loadPatientPrescriptionFromFirestore = async (code, clinicId = null) => {
        if (!code) return null;
        const scopedClinicId = clinicId || sessionStorage.getItem('patient_clinic_id') || null;
        if (scopedClinicId) {
            try {
                const patientSnap = await getDoc(doc(db, 'patients', getPatientDocId(scopedClinicId, code)));
                if (patientSnap.exists()) {
                    const data = { ...patientSnap.data(), _patientDocId: getPatientDocId(scopedClinicId, code), _fromFirestore: true };
                    if (data.status !== 'Archived') {
                        cachePrescription(data);
                        return data;
                    }
                }
            } catch (err) {
                console.warn('Scoped patient lookup skipped:', err);
            }
        }

        try {
            const accessSnap = await getDoc(doc(db, 'patient_access', getPatientAccessDocId(code)));
            if (!accessSnap.exists()) return null;
            const access = accessSnap.data();
            if (access.status === 'Archived' || !access.clinicId || !access.patientDocId) return null;
            const patientSnap = await getDoc(doc(db, 'patients', access.patientDocId));
            if (!patientSnap.exists()) return null;
            const patientData = { ...patientSnap.data(), _patientDocId: access.patientDocId, _fromFirestore: true };
            if (patientData.status === 'Archived') return null;
            cachePrescription(patientData);
            return patientData;
        } catch (err) {
            console.warn('Patient access-code cloud lookup skipped:', err);
            return null;
        }
    };

    const loadPatientPrescriptionByDocId = async (patientDocId) => {
        if (!patientDocId) return null;
        try {
            const patientSnap = await getDoc(doc(db, 'patients', patientDocId));
            if (!patientSnap.exists()) return null;
            const patientData = { ...patientSnap.data(), _patientDocId: patientDocId, _fromFirestore: true };
            if (patientData.status === 'Archived' || patientData.recordType === 'patientLogin') return null;
            cachePrescription(patientData);
            return patientData;
        } catch (err) {
            console.warn('Patient doc-id cloud lookup skipped:', err);
            return null;
        }
    };

    const savePatientSessionToFirestore = async (patientData) => {
        if (!patientData?.code) return false;
        try {
            const directPatientDocId = patientData._patientDocId || sessionStorage.getItem('patient_doc_id') || '';
            const accessSnap = await getDoc(doc(db, 'patient_access', getPatientAccessDocId(patientData.code)));
            const access = accessSnap.exists() ? accessSnap.data() : null;
            const patientDocId = access?.patientDocId || directPatientDocId;
            if (!patientDocId || access?.status === 'Archived') return false;
            await setDoc(doc(db, 'patients', patientDocId), {
                latestSession: patientData.latestSession,
                sessionHistory: patientData.sessionHistory || [],
                updatedAt: new Date().toISOString()
            }, { merge: true });
            return true;
        } catch (err) {
            console.warn('Patient session cloud sync skipped:', err);
            return false;
        }
    };

    const savePatientPreferencesToFirestore = async (code, preferences) => {
        if (!code || !preferences) return false;
        try {
            const directPatientDocId = sessionStorage.getItem('patient_doc_id') || '';
            const accessSnap = await getDoc(doc(db, 'patient_access', getPatientAccessDocId(code)));
            const access = accessSnap.exists() ? accessSnap.data() : null;
            const patientDocId = access?.patientDocId || directPatientDocId;
            if (!patientDocId || access?.status === 'Archived') return false;
            await setDoc(doc(db, 'patients', patientDocId), {
                patientPreferences: preferences,
                updatedAt: new Date().toISOString()
            }, { merge: true });
            return true;
        } catch (err) {
            console.warn('Patient preference cloud sync skipped:', err);
            return false;
        }
    };

    const resolvePatientPrescription = async (code, clinicId = null) => {
        let patientData = null;
        try {
            patientData = await loadPatientPrescriptionFromFirestore(code, clinicId);
        } catch (err) {
            console.warn('Patient cloud lookup skipped:', err);
        }
        if (patientData) return patientData;
        const localData = getCachedPrescription(code);
        return localData && localData.status !== 'Archived' ? localData : null;
    };

    const setPatientSession = ({ email, patientCode, clinicId, name, patientDocId }) => {
        sessionStorage.setItem('patient_email', normalizeEmail(email));
        sessionStorage.setItem('clinic_code', patientCode);
        sessionStorage.setItem('patient_clinic_id', clinicId || '');
        if (patientDocId) sessionStorage.setItem('patient_doc_id', patientDocId);
        if (name) sessionStorage.setItem('patient_name', name);
    };

    const createOrVerifyPatientAccount = async ({ name, email, password, key }) => {
        await ensureFirebaseLoaded();
        const emailLower = normalizeEmail(email);
        const patientName = name || 'Patient';
        const accessCode = String(key || '').trim().toUpperCase();

        if (!emailLower) throw new Error('Enter your email address to continue.');
        if (!password || password.length < 6) throw new Error('Enter a password with at least 6 characters.');

        const loginDocId = await getPatientLoginDocId(emailLower);
        const loginRef = doc(db, 'patients', loginDocId);
        let loginSnap = null;
        let loginLookupError = null;

        try {
            loginSnap = await getDoc(loginRef);
        } catch (err) {
            loginLookupError = err;
            console.warn('Patient login cloud lookup skipped:', err);
        }

        if (loginSnap?.exists()) {
            const loginData = loginSnap.data();
            if (loginData.status === 'Archived') throw new Error('This patient account is no longer active.');
            if (!loginData.passwordSalt || !loginData.passwordHash) throw new Error('This patient account needs to be set up again with the clinic-issued code.');

            const attemptedHash = await hashPatientPassword(password, loginData.passwordSalt);
            if (attemptedHash !== loginData.passwordHash) throw new Error('Email or password is incorrect.');

            const patientData = await loadPatientPrescriptionByDocId(loginData.patientDocId)
                || await resolvePatientPrescription(loginData.patientCode, loginData.clinicId)
                || getCachedPrescription(loginData.patientCode);
            if (!patientData || patientData.status === 'Archived') throw new Error('This patient access code is no longer active.');

            setPatientSession({
                email: emailLower,
                patientCode: loginData.patientCode,
                clinicId: patientData.clinicId || loginData.clinicId,
                name: loginData.name || patientName,
                patientDocId: patientData._patientDocId || loginData.patientDocId
            });
            return loginData.patientCode;
        }

        if (loginLookupError && accessCode.length < 6) throw loginLookupError;
        if (!accessCode || accessCode.length < 6) throw new Error('Enter the clinic-issued code for first-time setup.');
        const patientData = await loadPatientPrescriptionFromFirestore(accessCode);
        if (!patientData) throw new Error('Clinic-issued code was not found or is inactive.');
        if (patientData.hasPatientLogin && normalizeEmail(patientData.loginEmail || '') !== emailLower) {
            throw new Error('This clinic-issued code is already linked to a patient account.');
        }

        const clinicId = patientData.clinicId || 'CYRAXO-TX-01';
        const patientDocId = patientData._patientDocId || getPatientDocId(clinicId, accessCode);
        const salt = createSalt();
        const passwordHash = await hashPatientPassword(password, salt);
        const now = new Date().toISOString();
        const loginData = {
            recordType: 'patientLogin',
            loginDocId,
            email: emailLower,
            loginEmail: emailLower,
            name: patientName,
            patientCode: patientData.code || accessCode,
            code: patientData.code || accessCode,
            clinicId,
            patientDocId,
            passwordSalt: salt,
            passwordHash,
            passwordUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
            status: 'Active'
        };

        await setDoc(loginRef, loginData, { merge: false });
        if (!patientData.hasPatientLogin) {
            await setDoc(doc(db, 'patients', patientDocId), {
                patientEmail: emailLower,
                loginEmail: emailLower,
                patientName,
                hasPatientLogin: true,
                updatedAt: now
            }, { merge: true });
        }

        localStorage.setItem(`patient_login_${emailLower}`, JSON.stringify({
            email: emailLower,
            name: patientName,
            patientCode: accessCode,
            clinicId,
            patientDocId,
            loginDocId,
            status: 'Active'
        }));

        setPatientSession({ email: emailLower, patientCode: patientData.code || accessCode, clinicId, name: patientName, patientDocId });
        return accessCode;
    };

    // --- 2. DYNAMIC UI ROUTING ---
    const updateUIState = (viewId) => {
        const role = sessionStorage.getItem('cyrax_role');
        const subtext = document.getElementById('display-subtext');
        const breadcrumb = document.getElementById('breadcrumb-text');
        const displayName = document.getElementById('display-name');
        const displayAvatar = document.getElementById('display-avatar');

        if (!subtext || !breadcrumb) return;

        if (role === 'clinic') {
            displayName.innerText = "Clinical Staff";
            subtext.innerText = "Cyraxo Institutional Node";
            displayAvatar.innerText = "🩺";
            breadcrumb.innerHTML = `Portal / <span>${clinicViewTitles[viewId] || 'Dashboard'}</span>`;
        } else {
            displayName.innerText = "Patient Portal";
            subtext.innerText = "Recovery Code: " + (sessionStorage.getItem('clinic_code') || 'N/A');
            displayAvatar.innerText = "👤";
            const titles = { recovery: 'My Prescription', calendar: 'Exercise Calendar', progress: 'Recovery Progress', 'patient-settings': 'Account Settings' };
            breadcrumb.innerHTML = `Recovery / <span>${titles[viewId] || 'Dashboard'}</span>`;
        }
    };

    window.switchView = (viewId) => {
        document.querySelectorAll('.app-view').forEach(v => {
            v.style.display = 'none';
            v.classList.remove('active');
        });
        
        const targetView = document.getElementById('view-' + viewId);
        if (targetView) {
            targetView.style.display = 'block';
            targetView.classList.add('active');
        }

        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const targetNav = document.getElementById('nav-' + viewId);
        if (targetNav) targetNav.classList.add('active');

        updateUIState(viewId);
        document.querySelectorAll('.sidebar').forEach(s => s.classList.remove('open'));
    };

    window.handlePortalAuth = async (selectedRole, key) => {
        const error = document.getElementById('gate-error');
        const accessKeyInput = document.getElementById('demo-passkey');
        const submitButton = document.querySelector('#auth-form .btn');
        const showError = (message) => {
            if (!error) return;
            error.innerText = message;
            error.style.display = 'block';
        };
        const requestClinicCode = (message) => {
            if (accessKeyInput) {
                accessKeyInput.style.display = 'block';
                accessKeyInput.placeholder = 'Clinic-issued code';
                accessKeyInput.focus();
            }
            if (submitButton) submitButton.innerText = 'Link Clinic & Enter Portal';
            showError(message);
        };
        const isClinicCodeVisible = () => accessKeyInput && accessKeyInput.style.display !== 'none';

        if (selectedRole === 'clinic') {
            const clinicKey = normalizeClinicKey(key);
            if (!clinicKey) {
                showError('Enter your assigned clinic key.');
                return true;
            }
            try {
                await ensureFirebaseLoaded();
                const keySnap = await getDoc(doc(db, 'clinic_keys', clinicKey));
                if (!keySnap.exists()) {
                    showError('Invalid clinic key. Confirm the key issued by CyraxoHealth.');
                    return true;
                }
                const keyData = keySnap.data();
                if (keyData.status && keyData.status !== 'Active') {
                    showError('This clinic key is inactive. Contact CyraxoHealth support.');
                    return true;
                }
                sessionStorage.setItem('cyrax_auth', 'true');
                sessionStorage.setItem('cyrax_role', 'clinic');
                sessionStorage.setItem('clinic_code', keyData.clinicId || keyData.clinicCode || clinicKey);
                sessionStorage.setItem('clinic_key', clinicKey);
                sessionStorage.setItem('clinic_name', keyData.name || keyData.clinicName || clinicKey);
                location.reload();
                return true;
            } catch (err) {
                console.warn('Clinic key lookup failed:', err);
                showError('Clinic key could not be verified. Check Firebase rules and network access.');
                return true;
            }
        }

        if (selectedRole === 'patient') {
            const name = document.getElementById('patient-name')?.value.trim() || '';
            const email = document.getElementById('patient-email')?.value.trim() || '';
            const password = document.getElementById('patient-password')?.value || '';
            const accessCode = String(key || '').trim().toUpperCase();
            const originalButtonText = submitButton?.innerText || 'Continue';

            if (!email && !password && accessCode.length >= 6) {
                const patientData = await resolvePatientPrescription(accessCode);
                if (patientData) {
                    setPatientSession({
                        email: '',
                        patientCode: accessCode,
                        clinicId: patientData.clinicId || 'CYRAXO-TX-01',
                        name: '',
                        patientDocId: patientData._patientDocId
                    });
                    sessionStorage.setItem('cyrax_auth', 'true');
                    sessionStorage.setItem('cyrax_role', 'patient');
                    location.reload();
                    return true;
                }
                return false;
            }

            if (!email) {
                showError('Enter your email address to continue.');
                return true;
            }
            if (!password) {
                showError('Enter your password to continue.');
                return true;
            }

            try {
                if (submitButton) {
                    submitButton.disabled = true;
                    submitButton.innerText = 'Verifying Patient...';
                }
                await createOrVerifyPatientAccount({ name, email, password, key });
                sessionStorage.setItem('cyrax_auth', 'true');
                sessionStorage.setItem('cyrax_role', 'patient');
                location.reload();
            } catch (err) {
                const rawMessage = err.message || 'Unable to verify patient access.';
                const needsClinicCode = rawMessage.includes('clinic-issued code for first-time setup')
                    || rawMessage.includes('needs to be set up again')
                    || (!isClinicCodeVisible() && isPermissionError(err));
                if (
                    needsClinicCode
                ) {
                    requestClinicCode('No clinic is linked to this account yet. Enter your clinic-issued code to finish setup.');
                } else {
                    const message = isPermissionError(err)
                        ? `Firebase denied the patient link request (${err.code || 'permission-denied'}). Deploy the updated Firestore rules, then create or reopen the clinic patient record so it syncs to the patients collection.`
                        : rawMessage;
                    showError(message);
                }
            } finally {
                if (submitButton) {
                    submitButton.disabled = false;
                    if (!isClinicCodeVisible()) submitButton.innerText = originalButtonText;
                }
            }
            return true;
        }

        return false;
    };

    // --- 3. CLINICAL LOGIC (Registration & Management) ---
    window.registerPatient = async () => {
        const externalPatientId = document.getElementById('reg-external-id')?.value.trim() || '';
        const injury = document.getElementById('reg-injury').value;
        const romBaselineInput = document.getElementById('reg-rom-baseline');
        const romTargetInput = document.getElementById('reg-rom-target');
        const romUnit = document.getElementById('reg-rom-unit')?.value || 'degrees';
        const romBaseline = Number(romBaselineInput?.value);
        const romTarget = Number(romTargetInput?.value);
        const intensity = document.getElementById('reg-intensity').value;
        const timeline = document.getElementById('reg-timeline').value;
        const btn = document.querySelector('button[onclick="registerPatient()"]');

        if (!injury) { alert("Please specify injury type."); return; }
        if (!romBaselineInput?.value || Number.isNaN(romBaseline)) {
            alert("Please enter the patient's current ROM baseline.");
            romBaselineInput?.focus();
            return;
        }
        if (!romTargetInput?.value || Number.isNaN(romTarget)) {
            alert("Please enter the patient's target ROM.");
            romTargetInput?.focus();
            return;
        }
        if (romBaseline < 0 || romTarget < 0 || romBaseline > 180 || romTarget > 180) {
            alert("ROM values must be between 0 and 180.");
            return;
        }
        if (romTarget <= romBaseline) {
            alert("Target ROM should be greater than the current ROM baseline.");
            romTargetInput?.focus();
            return;
        }
        if (!canAddPatient()) {
            const limitText = currentClinicPlan.limit === Infinity ? 'unlimited' : currentClinicPlan.limit;
            alert(`Your ${currentClinicPlan.label} plan supports ${limitText} active patients. Remove a patient or upgrade the plan to add more.`);
            return;
        }
        
        btn.disabled = true;
        btn.innerText = "Generating AI Plan...";

        try {
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();
            
            // 1. Generate AI Plan immediately
            const aiExercises = (await window.ptAI.generatePrescription({
                type: injury, 
                intensity: intensity, 
                bio: `Timeline: ${timeline} weeks` 
            })).map(normalizeExercise);
            const exercises = [...aiExercises, ...newPatientCustomExercises]
                .filter((exercise) => exercise?.title)
                .filter((exercise, index, list) => list.findIndex((item) => item.title === exercise.title) === index)
                .map(normalizeExercise);

            // 2. Save locally and in Firestore for persistent clinic roster access
            const prescriptionData = {
                code: code,
                externalPatientId: externalPatientId,
                injury: injury,
                intensity: intensity,
                timeline: timeline,
                romBaseline,
                romTarget,
                romUnit,
                exercises: exercises,
                customExercises: newPatientCustomExercises,
                createdAt: new Date().toISOString(),
                clinicId: getCurrentClinicId(),
                status: 'Active'
            };
            cachePrescription(prescriptionData);
            let cloudSynced = false;
            try {
                cloudSynced = await savePatientToFirestore(prescriptionData);
                if (!cloudSynced) prescriptionData.syncStatus = 'Local only';
            } catch (syncErr) {
                console.warn('Patient cloud sync failed; local roster cache retained:', syncErr);
            }
            if (!cloudSynced) {
                alert('Patient was created locally, but Firebase sync failed. Patient email/password login from another device will not work until this record syncs to Firestore.');
            }

            document.getElementById('generated-code').innerText = code;
            document.getElementById('patient-modal').style.display = 'none';
            document.getElementById('code-result-modal').style.display = 'flex';
            newPatientCustomExercises = [];
            renderCustomExerciseDrafts();
            upsertPatientRow(prescriptionData, true);
        } catch (err) {
            console.error("Registration Failure:", err);
            alert("Patient could not be saved to the clinic roster. Please try again.");
        } finally {
            btn.disabled = false;
            btn.innerText = "Register Patient & Generate AI Plan";
        }
    };

    window.removePatient = async (code) => {
        if (!code) return;
        const confirmed = confirm(`#PX-${code} will be removed from the active roster. The record will be archived for audit history.`);
        if (!confirmed) return;

        const localData = getCachedPrescription(code) || {};
        const archivedData = {
            ...localData,
            code,
            clinicId: localData.clinicId || getCurrentClinicId(),
            status: 'Archived',
            archivedAt: new Date().toISOString()
        };

        localStorage.setItem(`prescription_${code}`, JSON.stringify(archivedData));
        try {
            await savePatientToFirestore(archivedData);
        } catch (err) {
            console.warn('Patient archive sync skipped:', err);
        }

        const row = document.querySelector(`#patient-list-body tr[data-px-code="${code}"]`);
        if (row) row.remove();
        clinicRosterPatients = clinicRosterPatients.filter((patient) => patient.code !== code);
        currentClinicPlan.activeCount = clinicRosterPatients.length;
        updatePlanStatus();
        renderPatientRoster();
    };

    // --- 4. PATIENT LOGIC (Recovery Hub) ---
    const renderPatientIdentity = (data = {}) => {
        const clinicLabel = data.clinicId || 'Clinic';
        const externalPatientId = data.externalPatientId || 'Not assigned';
        const attending = document.getElementById('attending-physician');
        const settingsId = document.getElementById('patient-settings-clinic-id');
        if (attending) {
            attending.innerText = data.externalPatientId ? `${clinicLabel} · Patient ID ${externalPatientId}` : clinicLabel;
        }
        if (settingsId) settingsId.innerText = externalPatientId;
    };

    const loadPatientPlan = async () => {
        const code = sessionStorage.getItem('clinic_code');
        if (!code) return;

        try {
            const parsedLocalData = getCachedPrescription(code);
            const clinicId = sessionStorage.getItem('patient_clinic_id') || parsedLocalData?.clinicId || null;
            const cloudOrLocalData = await resolvePatientPrescription(code, clinicId);
            const data = cloudOrLocalData || (parsedLocalData && parsedLocalData.status !== 'Archived' ? parsedLocalData : null);

            if (data) {
                sessionStorage.setItem('patient_clinic_id', data.clinicId || '');
                renderPatientIdentity(data);
                renderExercisePlan(data.exercises || []);
                renderCalendar(data);
                renderPatientProgress(data);
                loadPatientPreferences(data);
            } else {
                console.warn("No prescription found for code:", code);
                // Fallback for demo testing
                renderExercisePlan([
                    { id: 1, title: "Demo Exercise", duration: "10 mins", icon: "+" }
                ]);
                renderCalendar({});
                renderPatientProgress({});
            }
        } catch (err) {
            console.error("Local Load Error:", err);
            const fallbackData = getCachedPrescription(code) || {};
            renderPatientIdentity(fallbackData);
            renderExercisePlan(fallbackData.exercises || []);
            renderCalendar(fallbackData);
            renderPatientProgress(fallbackData);
            loadPatientPreferences(fallbackData);
        }
    };

    const renderExercisePlan = (exercises) => {
        const list = document.getElementById('patient-exercise-list');
        if (!list) return;
        
        const normalizedExercises = exercises.map(normalizeExercise);
        window.currentExercises = normalizedExercises;
        
        list.innerHTML = normalizedExercises.map((ex, index) => `
            <button class="exercise-card" type="button" onclick="openExercise(${index})" aria-label="Open ${escapeHtml(ex.title)} instructions">
                <div class="ex-icon">${escapeHtml(ex.icon)}</div>
                <div class="ex-info">
                    <h4>${escapeHtml(ex.title)}</h4>
                    <p>${escapeHtml(ex.description)}</p>
                    <div class="exercise-card-meta">
                        <span class="exercise-chip">${escapeHtml(ex.duration)}</span>
                        <span class="exercise-chip">${ex.steps.length} steps</span>
                    </div>
                </div>
                <span class="exercise-card-action" aria-hidden="true">›</span>
                <ol class="exercise-preview-steps">
                    ${ex.steps.slice(0, 2).map(step => `<li>${escapeHtml(step)}</li>`).join('')}
                </ol>
            </button>
        `).join('');
    };

    const renderCalendar = (planData = null) => {
        const cal = document.getElementById('recovery-calendar');
        if (!cal) return;
        
        const localData = planData || getCachedPrescription(sessionStorage.getItem('clinic_code')) || {};
        const timelineWeeks = parseInt(localData.timeline) || 4;
        const totalDays = timelineWeeks * 7;
        const todayDay = getCurrentScheduleDay(localData);
        const todayExercises = getScheduledExercisesForDay(localData, todayDay);
        const todayDate = toDateInputValue(getDateForScheduleDay(localData, todayDay));
        const appointments = { ...(localData.appointments || {}) };
        if (Object.keys(appointments).length === 0) {
            if (totalDays >= 14) appointments[14] = 'telehealth';
            appointments[totalDays] = 'clinic';
        }
        const todayAppointment = normalizeAppointment(appointments[todayDay], todayDay, localData);
        const todayPanel = document.getElementById('today-schedule-panel');

        let html = '';

        if (todayPanel) {
            todayPanel.innerHTML = `
                <div class="today-schedule-head">
                    <div>
                        <span class="eyebrow">Today's Plan</span>
                        <h3>Day ${todayDay} · ${formatScheduleDate(todayDate, { weekday: 'short', month: 'short', day: 'numeric' })}</h3>
                    </div>
                    <span class="today-count">${todayExercises.length || 'Rest'} ${todayExercises.length === 1 ? 'exercise' : todayExercises.length ? 'exercises' : 'day'}</span>
                </div>
                ${todayAppointment ? `
                    <div class="today-appointment">
                        <strong>${getVisitLabel(todayAppointment.type)}</strong>
                        <span>${todayAppointment.time ? `${escapeHtml(todayAppointment.time)} · ` : ''}${escapeHtml(todayAppointment.note || getVisitSubtext(todayAppointment.type))}</span>
                    </div>
                ` : ''}
                <div class="today-exercise-grid">
                    ${todayExercises.length ? todayExercises.map((exercise, index) => `
                        <button class="today-exercise-row" type="button" onclick="openExerciseByTitle('${escapeForInline(exercise.title)}')">
                            <span class="today-exercise-index">${index + 1}</span>
                            <span>
                                <strong>${escapeHtml(exercise.title)}</strong>
                                <small>${escapeHtml(exercise.sets || exercise.duration || exercise.description || 'As prescribed')}</small>
                            </span>
                        </button>
                    `).join('') : '<div class="empty-schedule">No exercises today. Focus on recovery, hydration, and easy movement.</div>'}
                </div>
            `;
        }

        for (let i = 1; i <= totalDays; i++) {
            const isToday = i === todayDay;
            const isDone = i < todayDay;
            const scheduledDate = toDateInputValue(getDateForScheduleDay(localData, i));
            const dailyExercises = getScheduledExercisesForDay(localData, i);
            
            let taskTitle = "Rest Day";
            let subText = "Recovery & Hydration";
            let alertMsg = `Day ${i} is a scheduled Rest Day. Focus on active recovery!`;
            let isAppointment = false;
            
            const appointment = normalizeAppointment(appointments[i], i, localData);
            const appType = appointment?.type;
            
            if (appointment) {
                taskTitle = getVisitLabel(appType);
                subText = appointment.time ? `${appointment.time} · ${getVisitSubtext(appType)}` : getVisitSubtext(appType);
                alertMsg = `Day ${i} (${formatScheduleDate(scheduledDate, { weekday: 'short', month: 'short', day: 'numeric' })}): ${getVisitLabel(appType)}${appointment.time ? ` at ${appointment.time}` : ''}.${appointment.note ? `\n\nNotes: ${appointment.note}` : ''}`;
                isAppointment = true;
            } else if (dailyExercises.length > 0) {
                // Active day
                if (dailyExercises.length > 0) {
                    let focus = i % 4 === 3 ? "Full Routine" : (i % 2 === 0 ? "Strength Focus" : "Mobility Focus");
                    taskTitle = focus;
                    subText = `${dailyExercises.length} Exercises`;
                    const exTitles = dailyExercises.map((e, idx) => `${idx + 1}. ${e.title}`).join('\n');
                    alertMsg = `Day ${i} Schedule (${focus}):\n\n${exTitles}`;
                }
            }

            // Styling adjustments for appointments vs regular days
            const appointmentClass = isAppointment ? getAppointmentClass(appType) : '';

            html += `
                <div class="cal-day ${isToday ? 'today' : ''} ${isDone ? 'complete' : ''} ${appointmentClass}" style="gap: 8px; cursor: pointer;" onclick="showPatientScheduleDay(${i})">
                    <div class="cal-day-top">
                        <span class="cal-date">${i}<span style="display:block; font-size:0.62rem; color: var(--text-muted);">${formatScheduleDate(scheduledDate)}</span></span>
                        <div class="cal-status ${isDone ? 'status-done' : (isAppointment ? 'status-pending' : 'status-pending')}"></div>
                    </div>
                    <div class="cal-day-title" style="color: ${isAppointment ? 'var(--primary)' : (isToday ? 'var(--primary-dark)' : 'var(--text-main)')};">
                        ${isAppointment ? getVisitShortLabel(appType) : taskTitle}
                    </div>
                    <div class="cal-day-sub">
                        ${subText}
                    </div>
                </div>
            `;
        }
        cal.innerHTML = html;
    };

    window.openExerciseByTitle = (title) => {
        const index = (window.currentExercises || []).findIndex((exercise) => exercise.title === title);
        if (index >= 0) window.openExercise(index);
    };

    window.showPatientScheduleDay = (day) => {
        const data = getCachedPrescription(sessionStorage.getItem('clinic_code')) || {};
        const scheduledDate = toDateInputValue(getDateForScheduleDay(data, day));
        const exercises = getScheduledExercisesForDay(data, day);
        const appointment = normalizeAppointment(data.appointments?.[day], day, data);
        const exerciseText = exercises.length
            ? exercises.map((exercise, index) => `${index + 1}. ${exercise.title} (${exercise.sets || exercise.duration || 'as prescribed'})`).join('\n')
            : 'Rest day';
        const appointmentText = appointment
            ? `\n\nAppointment: ${getVisitLabel(appointment.type)}${appointment.time ? ` at ${appointment.time}` : ''}${appointment.note ? `\nNotes: ${appointment.note}` : ''}`
            : '';
        alert(`Day ${day} · ${formatScheduleDate(scheduledDate, { weekday: 'short', month: 'short', day: 'numeric' })}\n\n${exerciseText}${appointmentText}`);
    };

    const getSessionHistory = (data = {}) => {
        const history = Array.isArray(data.sessionHistory) ? data.sessionHistory : [];
        return history.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
    };

    const getLatestSession = (data = {}) => data.latestSession || getSessionHistory(data)[0] || null;

    const getExpectedSessionCount = (data = {}) => {
        const timelineWeeks = parseInt(data.timeline) || 4;
        const elapsedDays = Math.max(1, Math.ceil((Date.now() - new Date(data.createdAt || Date.now())) / 86400000));
        return Math.max(1, Math.min(timelineWeeks * 5, Math.ceil(elapsedDays * 5 / 7)));
    };

    const getPatientProgressScore = (data = {}) => {
        const history = getSessionHistory(data);
        if (!history.length) return 0;
        return clamp(Math.round((history.length / getExpectedSessionCount(data)) * 100), 0, 100);
    };

    const renderPatientProgress = (data = {}) => {
        const sessionCountEl = document.getElementById('patient-progress-sessions');
        const romEl = document.getElementById('patient-progress-rom');
        const repsEl = document.getElementById('patient-progress-reps');
        const targetEl = document.getElementById('patient-progress-targets');
        const adherenceEl = document.getElementById('patient-progress-adherence');
        const trendEl = document.getElementById('patient-progress-trend');
        const historyEl = document.getElementById('patient-session-history');
        if (!sessionCountEl || !romEl || !repsEl || !targetEl) return;

        const history = getSessionHistory(data);
        const latest = getLatestSession(data);
        sessionCountEl.innerText = history.length;
        romEl.innerText = latest ? `${latest.romPercent}%` : '--';
        repsEl.innerText = latest ? latest.reps : '--';
        targetEl.innerText = latest?.targetAreas || 'Complete a guided session to generate targeted recommendations.';
        if (adherenceEl) adherenceEl.innerText = `${getPatientProgressScore(data)}%`;
        if (trendEl) {
            const trend = history.slice(0, 6).reverse();
            trendEl.innerHTML = trend.length
                ? trend.map((session) => `<div class="trend-bar" style="height:${clamp(session.romPercent || 0, 8, 100)}%;" title="${escapeHtml(session.exerciseTitle || 'Session')}: ${session.romPercent}% ROM"></div>`).join('')
                : '<p style="color: var(--text-muted);">No tracked sessions yet.</p>';
        }
        if (historyEl) {
            historyEl.innerHTML = history.length
                ? history.slice(0, 8).map((session) => `
                    <div class="session-row">
                        <div>
                            <strong>${escapeHtml(session.exerciseTitle || 'Guided Session')}</strong>
                            <span>${new Date(session.completedAt || Date.now()).toLocaleString()}</span>
                        </div>
                        <div>${session.romPercent}% ROM · ${session.reps} reps</div>
                    </div>
                `).join('')
                : '<div class="empty-schedule">Sessions will appear here after guided exercise tracking.</div>';
        }
    };

    const loadPatientPreferences = (patientData = {}) => {
        const notificationSelect = document.getElementById('patient-notification-pref');
        const sharingSelect = document.getElementById('patient-sharing-pref');
        const code = sessionStorage.getItem('clinic_code') || 'default';
        const prefs = patientData.patientPreferences || readJsonStorage(`patient_prefs_${code}`, {});
        if (notificationSelect && prefs.notifications) notificationSelect.value = prefs.notifications;
        if (sharingSelect && prefs.sharing) sharingSelect.value = prefs.sharing;
    };

    window.savePatientPreferences = async () => {
        const notificationSelect = document.getElementById('patient-notification-pref');
        const sharingSelect = document.getElementById('patient-sharing-pref');
        const status = document.getElementById('patient-settings-status');
        const code = sessionStorage.getItem('clinic_code') || 'default';
        const prefs = {
            notifications: notificationSelect?.value || 'Email and Push',
            sharing: sharingSelect?.value || 'Sync all sessions securely',
            updatedAt: new Date().toISOString()
        };
        localStorage.setItem(`patient_prefs_${code}`, JSON.stringify(prefs));
        savePatientPreferencesToFirestore(code, prefs);
        if (status) {
            status.innerText = 'Preferences saved.';
            setTimeout(() => { status.innerText = ''; }, 2500);
        }
    };

    // --- 5. INITIALIZATION ---
    if (activeAuth && activeRole) {
        document.getElementById('app-mount').style.display = 'flex';
        document.getElementById('demo-gate').style.display = 'none';
        
        if (activeRole === 'clinic') {
            document.getElementById('sidebar-clinic').style.display = 'flex';
            switchView('dashboard');
            try {
                await loadClinicPlan();
                await loadClinicPatients();
            } catch (err) {
                console.warn('Clinic data initialization skipped:', err);
                updatePlanStatus();
                renderEmptyRoster();
            }
        } else {
            document.getElementById('sidebar-patient').style.display = 'flex';
            switchView('recovery');
            try {
                await loadPatientPlan();
            } catch (err) {
                console.warn('Patient plan initialization skipped:', err);
            }
        }
    }

    // --- 6. AUTH & SESSION HELPERS ---
    window.toggleAppSidebar = () => {
        document.querySelectorAll('.sidebar').forEach(s => {
            if (s.style.display !== 'none') s.classList.toggle('open');
        });
    };

    window.logoutApp = () => {
        sessionStorage.clear();
        location.reload();
    };

    window.switchPortal = () => {
        sessionStorage.removeItem('cyrax_auth');
        sessionStorage.removeItem('cyrax_role');
        location.reload();
    };

    window.filterPatientRoster = () => renderPatientRoster();

    document.getElementById('profile-type')?.addEventListener('change', () => {
        window.clinicCalibration = {
            profileType: document.getElementById('profile-type')?.value || 'side',
            samples: [],
            requiredSamples: 30
        };
        renderClinicAnalysisState(null, 'Model changed. Hold the new camera angle steady to recalibrate.');
        const insightEl = document.getElementById('clinic-ai-insight');
        if (insightEl) insightEl.innerText = 'Capture stable telemetry to generate an automated assessment.';
    });

    window.showNewPatientModal = () => {
        if (!canAddPatient()) {
            const limitText = currentClinicPlan.limit === Infinity ? 'unlimited' : currentClinicPlan.limit;
            alert(`Your ${currentClinicPlan.label} plan supports ${limitText} active patients. Remove a patient or upgrade the plan to add more.`);
            return;
        }
        const externalIdInput = document.getElementById('reg-external-id');
        const injuryInput = document.getElementById('reg-injury');
        const romBaselineInput = document.getElementById('reg-rom-baseline');
        const romTargetInput = document.getElementById('reg-rom-target');
        const romUnitInput = document.getElementById('reg-rom-unit');
        const intensityInput = document.getElementById('reg-intensity');
        const timelineInput = document.getElementById('reg-timeline');
        const customTitleInput = document.getElementById('reg-custom-ex-title');
        const customSetsInput = document.getElementById('reg-custom-ex-sets');
        const customDetailInput = document.getElementById('reg-custom-ex-detail');
        if (externalIdInput) externalIdInput.value = '';
        if (injuryInput) injuryInput.value = '';
        if (romBaselineInput) romBaselineInput.value = '';
        if (romTargetInput) romTargetInput.value = '';
        if (romUnitInput) romUnitInput.value = 'degrees';
        if (intensityInput) intensityInput.value = 'medium';
        if (timelineInput) timelineInput.value = '4';
        if (customTitleInput) customTitleInput.value = '';
        if (customSetsInput) customSetsInput.value = '';
        if (customDetailInput) customDetailInput.value = '';
        newPatientCustomExercises = [];
        renderCustomExerciseDrafts();
        document.getElementById('patient-modal').style.display = 'flex';
    };
    window.closePatientModal = () => document.getElementById('patient-modal').style.display = 'none';
    window.closeCodeModal = () => document.getElementById('code-result-modal').style.display = 'none';

    const calculateAngle = (a, b, c) => {
        if (!a || !b || !c || a.visibility < 0.5 || b.visibility < 0.5 || c.visibility < 0.5) return null;
        const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
        let angle = Math.abs((radians * 180.0) / Math.PI);
        if (angle > 180.0) angle = 360 - angle;
        return angle;
    };

    const hasVisibleLandmarks = (landmarks, indices, threshold = 0.5) => {
        return indices.every((idx) => landmarks?.[idx] && (landmarks[idx].visibility ?? 1) >= threshold);
    };

    const defaultPoseConnections = [
        [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21],
        [12, 14], [14, 16], [16, 18], [16, 20], [16, 22],
        [11, 23], [12, 24], [23, 24],
        [23, 25], [25, 27], [27, 29], [27, 31],
        [24, 26], [26, 28], [28, 30], [28, 32],
        [0, 11], [0, 12]
    ];

    const getPoseConnections = () => Array.isArray(window.POSE_CONNECTIONS) && window.POSE_CONNECTIONS.length
        ? window.POSE_CONNECTIONS
        : defaultPoseConnections;

    const getJointMaskedConnections = (type = '') => {
        const connections = getPoseConnections();
        const t = type.toLowerCase();
        if (t.includes("rotator") || t.includes("shoulder")) {
            // Shoulder/Rotator Cuff: nose, shoulder belt, arms, and torso sides (connected to hips)
            const allowed = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
            return connections.filter(c => allowed.includes(c[0]) && allowed.includes(c[1]));
        }
        if (t.includes("elbow") || t.includes("tennis") || t.includes("wrist")) {
            // Elbow/Wrist/Tennis: shoulder belt, arms, and torso sides
            const allowed = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
            return connections.filter(c => allowed.includes(c[0]) && allowed.includes(c[1]));
        }
        if (t.includes("acl") || t.includes("knee") || t.includes("meniscus") || 
            t.includes("plantar") || t.includes("ankle") || t.includes("foot")) {
            // Knee/ACL/Meniscus/Ankle/Foot: shoulder belt, torso sides, hips, legs, and feet
            const allowed = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
            return connections.filter(c => allowed.includes(c[0]) && allowed.includes(c[1]));
        }
        if (t.includes("neck") || t.includes("cervical") || 
            t.includes("sciatica") || t.includes("disc") || t.includes("spine")) {
            // Spine/Sciatica/Disc/Neck/Cervical: nose, shoulders, hips, and knees
            const allowed = [0, 11, 12, 23, 24, 25, 26];
            return connections.filter(c => allowed.includes(c[0]) && allowed.includes(c[1]));
        }
        return connections;
    };

    const getActiveLandmarkIndices = (type = '') => {
        const indices = new Set();
        getJointMaskedConnections(type).forEach(([start, end]) => {
            indices.add(start);
            indices.add(end);
        });
        return indices;
    };

    const getRelevantBodyLabel = (type = '') => {
        const t = type.toLowerCase();
        if (t.includes("rotator") || t.includes("shoulder")) return "Shoulder and upper-torso mask";
        if (t.includes("elbow") || t.includes("tennis") || t.includes("wrist")) return "Arm and elbow mask";
        if (t.includes("acl") || t.includes("knee") || t.includes("meniscus")) return "Hip-knee-ankle mask";
        if (t.includes("plantar") || t.includes("ankle") || t.includes("foot")) return "Lower-leg and foot mask";
        if (t.includes("neck") || t.includes("cervical")) return "Head-neck-trunk mask";
        if (t.includes("sciatica") || t.includes("disc") || t.includes("spine")) return "Spine and hip mask";
        return "Relevant body mask";
    };

    const getRelevantLandmarkBox = (landmarks = [], activeIndices = new Set(), padding = 0.12) => {
        const visible = [...activeIndices]
            .map((idx) => landmarks[idx])
            .filter((lm) => lm && (lm.visibility ?? 1) >= 0.45);
        if (!visible.length) return null;
        const xs = visible.map((lm) => lm.x);
        const ys = visible.map((lm) => lm.y);
        return {
            x1: clamp(Math.min(...xs) - padding, 0, 1),
            y1: clamp(Math.min(...ys) - padding, 0, 1),
            x2: clamp(Math.max(...xs) + padding, 0, 1),
            y2: clamp(Math.max(...ys) + padding, 0, 1)
        };
    };

    const drawRelevantBodyMask = (ctx, segmentationMask, landmarks, type = '') => {
        if (!ctx || !segmentationMask || !landmarks?.length) return;
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        const activeIndices = getActiveLandmarkIndices(type);
        const box = getRelevantLandmarkBox(landmarks, activeIndices);
        if (!box) return;
        const x = box.x1 * width;
        const y = box.y1 * height;
        const w = (box.x2 - box.x1) * width;
        const h = (box.y2 - box.y1) * height;

        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.52)';
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.rect(x, y, w, h);
        ctx.fill('evenodd');

        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.globalAlpha = 0.34;
        ctx.drawImage(segmentationMask, 0, 0, width, height);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = 'rgba(123, 193, 183, 0.82)';
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.86)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();

        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.74)';
        ctx.font = '600 14px Outfit, sans-serif';
        const label = getRelevantBodyLabel(type);
        const labelWidth = ctx.measureText(label).width + 22;
        ctx.fillRect(x, Math.max(0, y - 34), labelWidth, 26);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(label, x + 11, Math.max(18, y - 16));
        ctx.restore();
    };

    const drawFallbackConnectors = (ctx, landmarks, connections, color = '#7BC1B7', lineWidth = 4) => {
        if (!ctx || !landmarks?.length || !connections?.length) return;
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        connections.forEach(([start, end]) => {
            const a = landmarks[start];
            const b = landmarks[end];
            if (!a || !b || (a.visibility ?? 1) < 0.45 || (b.visibility ?? 1) < 0.45) return;
            ctx.beginPath();
            ctx.moveTo(a.x * width, a.y * height);
            ctx.lineTo(b.x * width, b.y * height);
            ctx.stroke();
        });
        ctx.restore();
    };

    const drawFallbackLandmarks = (ctx, landmarks, activeIndices = null, color = '#FFFFFF', radius = 4) => {
        if (!ctx || !landmarks?.length) return;
        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(17, 24, 39, 0.55)';
        ctx.lineWidth = 1.5;
        landmarks.forEach((lm, idx) => {
            if (!lm || (lm.visibility ?? 1) < 0.45 || (activeIndices && !activeIndices.has(idx))) return;
            ctx.beginPath();
            ctx.arc(lm.x * width, lm.y * height, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
        ctx.restore();
    };

    const drawPoseOverlay = (ctx, landmarks, connections, options = {}) => {
        const connectorColor = options.connectorColor || '#7BC1B7';
        const landmarkColor = options.landmarkColor || '#FFFFFF';
        const lineWidth = options.lineWidth || 4;
        const radius = options.radius || 4;
        const activeIndices = new Set();
        connections.forEach(c => { activeIndices.add(c[0]); activeIndices.add(c[1]); });

        if (window.drawConnectors && window.drawLandmarks) {
            window.drawConnectors(ctx, landmarks, connections, { color: connectorColor, lineWidth });
            const filteredLandmarks = landmarks.map((lm, idx) => activeIndices.has(idx) ? lm : { x: 0, y: 0, z: 0, visibility: 0 });
            window.drawLandmarks(ctx, filteredLandmarks, { color: landmarkColor, lineWidth: 2, radius });
            return;
        }

        drawFallbackConnectors(ctx, landmarks, connections, connectorColor, lineWidth);
        drawFallbackLandmarks(ctx, landmarks, activeIndices, landmarkColor, radius);
    };

    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) });

    const lineTiltDegrees = (a, b) => {
        const raw = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
        return Math.min(raw, Math.abs(180 - raw));
    };

    const scoreFromDeviation = (deviation, tolerance) => Math.max(0, Math.min(100, Math.round(100 - (deviation / tolerance) * 100)));

    const formatScoreLabel = (score, good = 'Aligned', fair = 'Monitor', poor = 'Needs Review') => {
        if (score >= 85) return good;
        if (score >= 70) return fair;
        return poor;
    };

    const getAverageClinicAnalysis = (samples = []) => {
        const valid = samples.filter((sample) => sample?.scores);
        if (!valid.length) return null;
        const latest = valid[valid.length - 1];
        const avgScore = (key) => Math.round(valid.reduce((sum, sample) => sum + (Number(sample.scores[key]) || 0), 0) / valid.length);
        const scores = {
            cervical: avgScore('cervical'),
            thoracic: avgScore('thoracic'),
            pelvic: avgScore('pelvic')
        };
        return {
            ...latest,
            scores,
            overall: Math.round((scores.cervical + scores.thoracic + scores.pelvic) / 3)
        };
    };

    const updateAnalysisMeter = (key, score) => {
        const valueEl = document.getElementById(`clinic-score-${key}`);
        const meterEl = document.getElementById(`clinic-meter-${key}`);
        const clampedScore = clamp(Number(score) || 0, 0, 100);
        if (valueEl) valueEl.innerText = `${clampedScore}/100`;
        if (meterEl) {
            meterEl.style.width = `${clampedScore}%`;
            meterEl.style.background = clampedScore >= 85
                ? 'linear-gradient(90deg, #10B981, var(--primary))'
                : clampedScore >= 70
                    ? 'linear-gradient(90deg, #F59E0B, var(--primary))'
                    : 'linear-gradient(90deg, #EF4444, #F59E0B)';
        }
    };

    const renderClinicAnalysisState = (analysis = null, message = '') => {
        const stateEl = document.getElementById('clinic-analysis-state');
        const statusEl = document.getElementById('clinic-analysis-status');
        const samples = window.clinicCalibration?.samples?.length || 0;
        const required = window.clinicCalibration?.requiredSamples || 30;
        const calibrated = samples >= required;

        if (stateEl) stateEl.innerText = calibrated ? 'Calibrated' : samples ? `Calibrating ${samples}/${required}` : 'Standby';
        if (statusEl) {
            statusEl.innerText = message || (analysis
                ? `${analysis.alert}. Hold steady or switch model when changing camera angle.`
                : 'Choose a model and start the camera to begin calibration.');
        }
        if (analysis?.scores) {
            updateAnalysisMeter('cervical', analysis.scores.cervical);
            updateAnalysisMeter('thoracic', analysis.scores.thoracic);
            updateAnalysisMeter('pelvic', analysis.scores.pelvic);
        }
    };

    const analyzeClinicPose = (landmarks, profileType = 'side') => {
        if (!landmarks) return null;
        if (profileType === 'back') {
            if (!hasVisibleLandmarks(landmarks, [11, 12, 23, 24])) return null;
            const shoulderTilt = Math.abs(lineTiltDegrees(landmarks[11], landmarks[12]));
            const pelvicTilt = Math.abs(lineTiltDegrees(landmarks[23], landmarks[24]));
            const shoulderMid = midpoint(landmarks[11], landmarks[12]);
            const hipMid = midpoint(landmarks[23], landmarks[24]);
            const trunkOffset = Math.abs(shoulderMid.x - hipMid.x) * 100;
            const cervicalScore = scoreFromDeviation(trunkOffset, 12);
            const thoracicScore = scoreFromDeviation(shoulderTilt, 14);
            const pelvicScore = scoreFromDeviation(pelvicTilt, 14);
	            return {
	                cervical: formatScoreLabel(cervicalScore),
	                thoracic: `${Math.round(shoulderTilt)}° shoulder tilt`,
	                pelvic: `${Math.round(pelvicTilt)}° pelvic tilt`,
	                scores: { cervical: cervicalScore, thoracic: thoracicScore, pelvic: pelvicScore },
	                overall: Math.round((cervicalScore + thoracicScore + pelvicScore) / 3),
	                alert: shoulderTilt > 8 || pelvicTilt > 8 ? 'Asymmetry detected' : 'Symmetry within range'
	            };
        }

        if (!hasVisibleLandmarks(landmarks, [0, 11, 12, 23, 24])) return null;
        const headPoint = landmarks[0];
        const shoulderMid = midpoint(landmarks[11], landmarks[12]);
        const hipMid = midpoint(landmarks[23], landmarks[24]);
        const cervicalOffset = Math.abs(headPoint.x - shoulderMid.x) * 100;
        const thoracicLean = Math.abs(Math.atan2(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y) * 180 / Math.PI);
        const shoulderHipAngle = calculateAngle(headPoint, shoulderMid, hipMid) || 180;
        const cervicalScore = scoreFromDeviation(cervicalOffset, 10);
        const thoracicScore = scoreFromDeviation(thoracicLean, 16);
        const pelvicScore = scoreFromDeviation(Math.abs(180 - shoulderHipAngle), 28);
	        return {
	            cervical: `${Math.round(cervicalOffset)}% forward offset`,
	            thoracic: `${Math.round(thoracicLean)}° trunk lean`,
	            pelvic: formatScoreLabel(pelvicScore, 'Stacked', 'Compensating', 'Unstacked'),
	            scores: { cervical: cervicalScore, thoracic: thoracicScore, pelvic: pelvicScore },
	            overall: Math.round((cervicalScore + thoracicScore + pelvicScore) / 3),
	            alert: cervicalOffset > 7 || thoracicLean > 10 ? 'Postural deviation detected' : 'Alignment within range'
	        };
    };

    const getTrackedAngle = (landmarks, type = '') => {
        if (!landmarks) return null;
        if (type.includes("knee") || type.includes("acl") || type.includes("meniscus")) {
            return calculateAngle(landmarks[24], landmarks[26], landmarks[28]);
        }
        if (type.includes("rotator") || type.includes("shoulder") || type.includes("neck")) {
            return calculateAngle(landmarks[24], landmarks[12], landmarks[14]);
        }
        return calculateAngle(landmarks[12], landmarks[14], landmarks[16]);
    };

    const getTrackingLandmarkIndices = (type = '') => {
        if (type.includes("knee") || type.includes("acl") || type.includes("meniscus")) return [24, 26, 28];
        if (type.includes("rotator") || type.includes("shoulder") || type.includes("neck")) return [24, 12, 14];
        return [12, 14, 16];
    };

    const getSmoothedAngle = (sessionData, angle) => {
        if (!sessionData || angle === null) return angle;
        sessionData.angleWindow = [...(sessionData.angleWindow || []), angle].slice(-5);
        const values = sessionData.angleWindow;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    const runKinematicVerifier = (sessionData = {}) => {
        const angles = Array.isArray(sessionData.angleSamples) ? sessionData.angleSamples : [];
        const quality = sessionData.totalFrames ? Math.round((sessionData.qualityFrames / sessionData.totalFrames) * 100) : 0;
        const romSpan = Math.max(0, Math.abs((sessionData.maxAngle ?? 0) - (sessionData.minAngle ?? 0)));
        if (angles.length < 8) {
            return {
                confidence: Math.max(25, Math.round(quality * 0.55)),
                consistency: 0,
                romSpan,
                quality,
                flags: ['Limited motion samples']
            };
        }
        const deltas = angles.slice(1).map((angle, idx) => Math.abs(angle - angles[idx]));
        const avgDelta = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
        const jitter = deltas.filter((value) => value > Math.max(10, avgDelta * 2.8)).length / Math.max(1, deltas.length);
        const calibrationRange = Number(sessionData.baselineSpan || 0);
        const rangeConsistency = calibrationRange ? clamp(Math.round((romSpan / calibrationRange) * 100), 0, 120) : 0;
        const consistency = clamp(Math.round(100 - (jitter * 100)), 0, 100);
        const confidence = clamp(Math.round((quality * 0.4) + (consistency * 0.35) + (Math.min(rangeConsistency, 100) * 0.25)), 0, 100);
        const flags = [];
        if (quality < 65) flags.push('Low landmark visibility');
        if (consistency < 70) flags.push('Irregular angle sequence');
        if (romSpan < 8) flags.push('Limited range captured');
        return { confidence, consistency, romSpan: Math.round(romSpan), quality, flags };
    };

    const resetPatientCameraControls = (message = 'Camera Offline') => {
        const statusOverlay = document.getElementById('patient-status-overlay');
        const startBtn = document.getElementById('start-session-btn');
        const endBtn = document.getElementById('end-session-btn');
        const instructions = document.getElementById('session-instructions');
        const progressContainer = document.getElementById('session-progress-bar-container');
        if (statusOverlay) {
            statusOverlay.innerText = message;
            statusOverlay.style.display = 'flex';
        }
        if (startBtn) startBtn.style.display = 'block';
        if (endBtn) endBtn.style.display = 'none';
        if (instructions) instructions.style.display = 'none';
        if (progressContainer) progressContainer.style.display = 'none';
        window.sessionData = null;
    };

    window.startPatientCameraSession = () => {
        if (window.patientCamera) return; // Prevent multiple instances

        const videoElement = document.getElementById('patient-video');
        const canvasElement = document.getElementById('patient-output-canvas');
        const canvasCtx = canvasElement.getContext('2d');
        const statusOverlay = document.getElementById('patient-status-overlay');

        if (!videoElement || !canvasElement) return;
        if (!window.Pose || !window.Camera) {
            resetPatientCameraControls("Motion engine failed to load. Refresh the page and try again.");
            return;
        }

        if (!window.activeSessionSteps?.length && window.currentExercises?.length) {
            const firstExercise = normalizeExercise(window.currentExercises[0], 0);
            window.activeSessionDesc = firstExercise.description;
            window.activeSessionSteps = firstExercise.steps;
            const nameSpan = document.getElementById('current-exercise-name');
            if (nameSpan) nameSpan.innerText = firstExercise.title;
        }

        statusOverlay.innerText = "Initializing Motion Engine...";
        statusOverlay.style.display = 'flex';

        const pose = new window.Pose({locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
        }});

	        pose.setOptions({
	            modelComplexity: 2,
	            smoothLandmarks: true,
                enableSegmentation: true,
                smoothSegmentation: true,
	            minDetectionConfidence: 0.7,
	            minTrackingConfidence: 0.7
	        });

        // Setup session tracking data
        window.sessionData = {
            reps: 0,
            stage: 'down',
            minAngle: 180,
            maxAngle: 0,
            calibratedMin: null,
            calibratedMax: null,
            baselineSpan: null,
            highThreshold: 160,
            lowThreshold: 90,
            calibrationSamples: [],
	            calibrationStartedAt: null,
	            isCalibrating: true,
	            isActive: false,
	            targetReps: 10,
	            qualityFrames: 0,
	            totalFrames: 0,
	            repFeedbackIndex: 0,
                angleSamples: [],
                angleWindow: [],
                frameSnapshots: [],
                lastSnapshotAt: 0,
                maskLabel: ''
	        };

        const instructions = document.getElementById('session-instructions');
        const progressContainer = document.getElementById('session-progress-bar-container');
	        const progressBar = document.getElementById('session-progress-bar');
	        const repFeedback = [
	            "Strong rep. Keep that same control.",
	            "Nice range. Smooth return.",
	            "Good tempo. Stay steady.",
	            "Clean movement. Keep breathing.",
	            "Great control through the full range.",
	            "That rep counted. Keep the alignment.",
	            "Excellent pace. One rep closer.",
	            "Solid form. Reset and repeat."
	        ];
	        const getSessionInstructionText = () => {
            const steps = Array.isArray(window.activeSessionSteps) && window.activeSessionSteps.length
                ? window.activeSessionSteps
                : getExerciseInstructions({ title: document.getElementById('current-exercise-name')?.innerText || '' });
            const repIndex = Math.max(0, (window.sessionData?.reps || 0) % steps.length);
            const nextRep = Math.min((window.sessionData?.reps || 0) + 1, window.sessionData?.targetReps || 10);
            return `Step ${repIndex + 1}: ${steps[repIndex]} (Rep ${nextRep} / ${window.sessionData?.targetReps || 10})`;
        };
        const completeCalibration = () => {
	            const samples = window.sessionData.calibrationSamples.slice().sort((a, b) => a - b);
	            const trim = Math.max(0, Math.floor(samples.length * 0.08));
	            const stableSamples = samples.slice(trim, samples.length - trim || samples.length);
	            const min = Math.min(...stableSamples);
	            const max = Math.max(...stableSamples);
	            const span = Math.max(1, max - min);
            window.sessionData.calibratedMin = min;
            window.sessionData.calibratedMax = max;
            window.sessionData.baselineSpan = span;
	            window.sessionData.lowThreshold = min + (span * 0.32);
	            window.sessionData.highThreshold = min + (span * 0.76);
            window.sessionData.minAngle = max;
            window.sessionData.maxAngle = min;
            window.sessionData.stage = 'down';
            window.sessionData.isCalibrating = false;
            window.sessionData.isActive = true;
            progressBar.style.width = '0%';
	            instructions.innerText = `Calibration complete: ${Math.round(span)}° baseline range from ${stableSamples.length} samples. ${getSessionInstructionText()}`;
	        };

        pose.onResults((results) => {
            statusOverlay.style.display = 'none';
            canvasCtx.save();
            // Set canvas size to match video to avoid stretching
            if(canvasElement.width !== videoElement.videoWidth) {
                canvasElement.width = videoElement.videoWidth;
                canvasElement.height = videoElement.videoHeight;
            }
            canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
            canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
            
            if (results.poseLandmarks) {
                const localData = getCachedPrescription(sessionStorage.getItem('clinic_code')) || {};
                const type = (localData.injury || "").toLowerCase();
                const activeConnections = getJointMaskedConnections(type);
                drawRelevantBodyMask(canvasCtx, results.segmentationMask, results.poseLandmarks, type);
                drawPoseOverlay(canvasCtx, results.poseLandmarks, activeConnections, {
                    connectorColor: '#7BC1B7',
                    landmarkColor: '#FFFFFF',
                    lineWidth: 5,
                    radius: 4
                });

	                const rawAngle = getTrackedAngle(results.poseLandmarks, type);
                    const angle = getSmoothedAngle(window.sessionData, rawAngle);
	                if (window.sessionData) {
	                    window.sessionData.totalFrames += 1;
	                    const visibleEnough = hasVisibleLandmarks(results.poseLandmarks, getTrackingLandmarkIndices(type), 0.6);
	                    if (visibleEnough) window.sessionData.qualityFrames += 1;
                        window.sessionData.maskLabel = getRelevantBodyLabel(type);
                        if (angle !== null) window.sessionData.angleSamples.push(Number(angle.toFixed(2)));
                        const now = Date.now();
                        if (visibleEnough && window.sessionData.frameSnapshots.length < 3 && now - window.sessionData.lastSnapshotAt > 1800) {
                            try {
                                window.sessionData.frameSnapshots.push(canvasElement.toDataURL('image/jpeg', 0.58));
                                window.sessionData.lastSnapshotAt = now;
                            } catch (err) {
                                console.warn('Motion frame capture skipped:', err);
                            }
                        }
	                }

	                if (angle !== null && window.sessionData.isCalibrating) {
	                    if (!window.sessionData.calibrationStartedAt) window.sessionData.calibrationStartedAt = Date.now();
	                    window.sessionData.calibrationSamples.push(angle);
	                    const elapsed = Date.now() - window.sessionData.calibrationStartedAt;
	                    const samples = window.sessionData.calibrationSamples;
	                    const span = Math.max(...samples) - Math.min(...samples);
	                    const progress = Math.min(100, (elapsed / 7000) * 100);
	                    progressBar.style.width = `${progress}%`;
	                    instructions.innerText = `Calibration: slowly move through your comfortable range. Captured ${Math.round(span)}° across ${samples.length} samples.`;
	                    if ((elapsed >= 7000 && span >= 12 && samples.length >= 45) || (elapsed >= 11000 && span >= 8 && samples.length >= 35)) {
	                        completeCalibration();
	                    } else if (elapsed >= 11000) {
	                        instructions.innerText = "Calibration needs more movement. Slowly extend and bend through your comfortable range.";
	                        window.sessionData.calibrationSamples = [];
	                        window.sessionData.calibrationStartedAt = Date.now();
                        progressBar.style.width = '0%';
                    }
                }

                // ACTUAL KINEMATIC TRACKING & REP COUNTING
                if (window.sessionData.isActive && angle !== null) {
                        // Track Max/Min range of motion for accurate reporting
                        if (angle > window.sessionData.maxAngle) window.sessionData.maxAngle = angle;
                        if (angle < window.sessionData.minAngle) window.sessionData.minAngle = angle;

                        // Rep counting uses calibrated thresholds from the patient's measured range.
                        if (angle > window.sessionData.highThreshold) {
                            window.sessionData.stage = 'up';
                        }
                        if (angle < window.sessionData.lowThreshold && window.sessionData.stage === 'up') {
                            window.sessionData.stage = 'down';
                            window.sessionData.reps += 1;
                            
                            // Update UI immediately on rep completion
                            const progress = (window.sessionData.reps / window.sessionData.targetReps) * 100;
                            progressBar.style.width = `${progress}%`;
                            
	                            const feedback = repFeedback[window.sessionData.repFeedbackIndex % repFeedback.length];
	                            window.sessionData.repFeedbackIndex += 1;
	                            instructions.innerText = `${feedback} ${getSessionInstructionText()}`;

	                            // Auto-terminate when target reached
	                            if (window.sessionData.reps >= window.sessionData.targetReps) {
	                                instructions.innerText = "Excellent work. Session complete. Analyzing biomechanics...";
                                setTimeout(() => { window.endPatientCameraSession(); }, 1500);
                            }
                        }
                }
            }
            canvasCtx.restore();
        });

        window.patientCamera = new window.Camera(videoElement, {
            onFrame: async () => {
                await pose.send({image: videoElement});
            },
            width: 640,
            height: 480,
            facingMode: window.patientFacingMode
        });
        
        window.patientCamera.start().then(() => {
            console.log("Patient camera started");
            applyWideCameraMode(videoElement, window.patientWideCamera).catch(console.warn);
            updateWideCameraButton('patient-wide-toggle', window.patientWideCamera);
            document.getElementById('end-session-btn').style.display = 'block';
            document.getElementById('start-session-btn').style.display = 'none';
            
            instructions.style.display = 'block';
            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';
            
            instructions.innerText = "Calibration: align in frame, then slowly move through your comfortable range.";

        }).catch(err => {
            if (window.patientCamera) {
                window.patientCamera.stop();
                window.patientCamera = null;
            }
            resetPatientCameraControls("Camera Access Denied");
            console.error(err);
        });
    };

    window.flipPatientCamera = () => {
        window.patientFacingMode = window.patientFacingMode === 'user' ? 'environment' : 'user';
        const wasActive = Boolean(window.patientCamera);
        if (window.patientCamera) {
            window.patientCamera.stop();
            window.patientCamera = null;
        }
        if (wasActive) window.startPatientCameraSession();
    };

    window.togglePatientWideCamera = () => {
        window.patientWideCamera = !window.patientWideCamera;
        updateWideCameraButton('patient-wide-toggle', window.patientWideCamera);
        const videoElement = document.getElementById('patient-video');
        if (window.patientCamera) {
            applyWideCameraMode(videoElement, window.patientWideCamera).catch(console.warn);
        }
    };

    window.closeClinicCameraSession = () => {
        if (window.clinicCamera) {
            window.clinicCamera.stop();
            window.clinicCamera = null;
        }
        const btn = document.getElementById('clinic-camera-toggle');
        const statusOverlay = document.getElementById('status-overlay');
        if (btn) btn.innerText = 'Start Clinic Camera';
        if (statusOverlay) {
            statusOverlay.innerText = 'Camera Offline';
            statusOverlay.style.display = 'flex';
        }
        renderClinicAnalysisState(null, 'Camera stopped. Start again to capture a new calibrated sample set.');
    };

    window.toggleClinicCameraSession = () => {
        if (window.clinicCamera) {
            window.closeClinicCameraSession();
            return;
        }
        window.startClinicCameraSession();
    };


    window.editPatientSchedule = (pxCode) => {
        window.activeSchedulePatientCode = pxCode;
        switchView('clinic-schedule');
        document.getElementById('schedule-px-title').innerText = '#PX-' + pxCode;
        
        const cal = document.getElementById('clinic-editable-calendar');
        if (!cal) return;
        
        const localData = getCachedPrescription(pxCode) || {};
        if (!localData.code) {
            localData.code = pxCode;
            localData.timeline = localData.timeline || 4;
            localData.createdAt = localData.createdAt || new Date().toISOString();
            localStorage.setItem(`prescription_${pxCode}`, JSON.stringify(localData));
        }

        const timelineWeeks = parseInt(localData.timeline) || 4;
        const totalDays = timelineWeeks * 7;
        let appointments = localData.appointments || {}; 
        
        // Ensure default appointments exist if not yet saved
        if (Object.keys(appointments).length === 0) {
            if (totalDays >= 14) appointments[14] = 'telehealth';
            appointments[totalDays] = 'clinic';
        }
        localData.appointments = appointments;
        localStorage.setItem(`prescription_${pxCode}`, JSON.stringify(localData));

        const dateInput = document.getElementById('schedule-date');
        const timeInput = document.getElementById('schedule-time');
        const typeInput = document.getElementById('schedule-type');
        const notesInput = document.getElementById('schedule-notes');
        const meta = document.getElementById('schedule-patient-meta');
        if (dateInput) {
            dateInput.min = toDateInputValue(getDateForScheduleDay(localData, 1));
            dateInput.max = toDateInputValue(getDateForScheduleDay(localData, totalDays));
            if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
                dateInput.value = dateInput.min;
            }
        }
        if (timeInput && !timeInput.value) timeInput.value = '09:00';
        if (typeInput) typeInput.value = 'telehealth';
        if (notesInput) notesInput.value = '';
        if (meta) {
            meta.innerText = `${timelineWeeks}-week plan · ${formatScheduleDate(dateInput.min)} to ${formatScheduleDate(dateInput.max)}`;
        }

        const renderScheduleList = () => {
            const list = document.getElementById('schedule-appointment-list');
            if (!list) return;
            const latestData = getCachedPrescription(pxCode) || {};
            appointments = latestData.appointments || {};

            const sorted = Object.keys(appointments)
                .map(day => ({ day: Number(day), appointment: normalizeAppointment(appointments[day], day, localData) }))
                .filter(item => item.appointment)
                .sort((a, b) => a.day - b.day);

            if (sorted.length === 0) {
                list.innerHTML = '<div class="empty-schedule">No appointments scheduled yet.</div>';
                return;
            }

            list.innerHTML = sorted.map(({ day, appointment }) => `
                <div class="schedule-item">
                    <div class="schedule-item-date">
                        ${formatScheduleDate(appointment.date, { day: 'numeric' })}
                        <span>${formatScheduleDate(appointment.date, { month: 'short' })}</span>
                    </div>
                    <div>
                        <h4>${getVisitLabel(appointment.type)}</h4>
                        <p>Day ${day}${appointment.time ? ` · ${appointment.time}` : ''}${appointment.note ? ` · ${escapeHtml(appointment.note)}` : ''}</p>
                    </div>
                    <button class="btn btn-secondary schedule-delete" onclick="removeScheduleAppointment(${day})">Remove</button>
                </div>
            `).join('');
        };

        const renderScheduleSessions = () => {
            const list = document.getElementById('schedule-session-list');
            if (!list) return;
            const latestData = getCachedPrescription(pxCode) || {};
            const history = getSessionHistory(latestData);
            if (!history.length) {
                list.innerHTML = '<div class="empty-schedule">No synced patient sessions yet.</div>';
                return;
            }
            list.innerHTML = history.slice(0, 6).map((session) => `
                <article class="clinic-session-card compact-session-card">
                    <div class="clinic-session-card-head">
                        <div>
                            <h5>${escapeHtml(session.exerciseTitle || 'Guided Session')}</h5>
                            <small>${escapeHtml(new Date(session.completedAt || Date.now()).toLocaleString())}</small>
                        </div>
                        <span class="verification-badge ${escapeHtml(String(session.verificationStatus || 'review').toLowerCase())}">${escapeHtml(session.verificationStatus || 'review')}</span>
                    </div>
                    <div class="clinic-session-metrics">
                        <span><strong>${escapeHtml(String(session.romPercent ?? '--'))}%</strong>ROM</span>
                        <span><strong>${escapeHtml(String(session.reps ?? '--'))}</strong>Reps</span>
                        <span><strong>${escapeHtml(String(session.trackingQuality ?? '--'))}%</strong>Tracking</span>
                    </div>
                </article>
            `).join('');
        };

        const populateScheduleExerciseControls = () => {
            const daySelect = document.getElementById('schedule-exercise-day');
            const exerciseSelect = document.getElementById('schedule-exercise-select');
            if (daySelect) {
                daySelect.innerHTML = Array.from({ length: totalDays }, (_, index) => {
                    const day = index + 1;
                    const date = toDateInputValue(getDateForScheduleDay(localData, day));
                    return `<option value="${day}">Day ${day} · ${formatScheduleDate(date, { month: 'short', day: 'numeric' })}</option>`;
                }).join('');
                if (!daySelect.value) daySelect.value = String(getCurrentScheduleDay(localData));
            }
            if (exerciseSelect) {
                exerciseSelect.innerHTML = getPatientExerciseLibrary(getCachedPrescription(pxCode) || localData).map((exercise, index) => (
                    `<option value="${index}">${escapeHtml(exercise.title)}</option>`
                )).join('');
            }
        };

        const saveScheduleExercises = (data) => {
            localStorage.setItem(`prescription_${pxCode}`, JSON.stringify(data));
            savePatientToFirestore(data).catch((err) => console.warn('Schedule exercise sync skipped:', err));
            renderEditor();
        };

        window.renderSelectedScheduleDayExercises = () => {
            const list = document.getElementById('schedule-day-exercise-list');
            const daySelect = document.getElementById('schedule-exercise-day');
            if (!list || !daySelect) return;
            const data = getCachedPrescription(pxCode) || localData;
            const day = Number(daySelect.value || getCurrentScheduleDay(data));
            const exercisesForDay = getScheduledExercisesForDay(data, day);
            if (!exercisesForDay.length) {
                list.innerHTML = '<div class="empty-schedule">No exercises assigned for this day.</div>';
                return;
            }
            list.innerHTML = exercisesForDay.map((exercise, index) => `
                <div class="scheduled-exercise-row">
                    <div>
                        <strong>${escapeHtml(exercise.title)}</strong>
                        <span>${escapeHtml(exercise.sets || exercise.duration || 'As prescribed')}${exercise.note ? ` · ${escapeHtml(exercise.note)}` : ''}</span>
                    </div>
                    <div class="row-actions">
                        <button class="btn btn-secondary" type="button" onclick="moveScheduleExercise(${index}, -1)">Up</button>
                        <button class="btn btn-secondary" type="button" onclick="moveScheduleExercise(${index}, 1)">Down</button>
                        <button class="btn btn-danger" type="button" onclick="removeExerciseFromScheduleDay(${index})">Remove</button>
                    </div>
                </div>
            `).join('');
        };

        window.addExerciseToScheduleDay = () => {
            const data = getCachedPrescription(pxCode) || localData;
            const day = Number(document.getElementById('schedule-exercise-day')?.value || getCurrentScheduleDay(data));
            const library = getPatientExerciseLibrary(data);
            const selectedIndex = Number(document.getElementById('schedule-exercise-select')?.value || 0);
            const selected = library[selectedIndex];
            if (!selected) {
                alert('Add an exercise to the patient plan first.');
                return;
            }
            const reps = Security.sanitize(document.getElementById('schedule-exercise-reps')?.value || '');
            const note = Security.sanitize(document.getElementById('schedule-exercise-note')?.value || '');
            const current = getScheduledExercisesForDay(data, day);
            data.dailyExercises = data.dailyExercises || {};
            data.dailyExercises[day] = [
                ...current,
                normalizeExercise({
                    ...selected,
                    id: `${selected.id || selected.title}-${Date.now()}`,
                    sets: reps || selected.sets || selected.duration || 'As prescribed',
                    note,
                    duration: reps || selected.duration || 'As prescribed'
                })
            ];
            const noteInput = document.getElementById('schedule-exercise-note');
            if (noteInput) noteInput.value = '';
            saveScheduleExercises(data);
        };

        window.removeExerciseFromScheduleDay = (index) => {
            const data = getCachedPrescription(pxCode) || localData;
            const day = Number(document.getElementById('schedule-exercise-day')?.value || getCurrentScheduleDay(data));
            const current = getScheduledExercisesForDay(data, day);
            current.splice(index, 1);
            data.dailyExercises = data.dailyExercises || {};
            data.dailyExercises[day] = current;
            saveScheduleExercises(data);
        };

        window.moveScheduleExercise = (index, direction) => {
            const data = getCachedPrescription(pxCode) || localData;
            const day = Number(document.getElementById('schedule-exercise-day')?.value || getCurrentScheduleDay(data));
            const current = getScheduledExercisesForDay(data, day);
            const nextIndex = index + direction;
            if (nextIndex < 0 || nextIndex >= current.length) return;
            [current[index], current[nextIndex]] = [current[nextIndex], current[index]];
            data.dailyExercises = data.dailyExercises || {};
            data.dailyExercises[day] = current;
            saveScheduleExercises(data);
        };

        window.selectScheduleExerciseDay = (day) => {
            const daySelect = document.getElementById('schedule-exercise-day');
            if (daySelect) daySelect.value = String(day);
            window.renderSelectedScheduleDayExercises();
        };

        const renderEditor = () => {
            const latestData = getCachedPrescription(pxCode) || {};
            appointments = latestData.appointments || {};
            let html = '';
            for (let i = 1; i <= totalDays; i++) {
                const appointment = normalizeAppointment(appointments[i], i, localData);
                const scheduledExercises = getScheduledExercisesForDay(latestData, i);
                const appType = appointment?.type;
                const appointmentClass = appointment ? getAppointmentClass(appType) : '';
                let title = 'Standard Day';
                let subText = scheduledExercises.length ? `${scheduledExercises.length} exercises` : 'Rest day';
                const scheduledDate = toDateInputValue(getDateForScheduleDay(localData, i));
                
                if (appointment) {
                    title = getVisitShortLabel(appType);
                    subText = `${appointment.time ? appointment.time : getVisitSubtext(appType)} · ${scheduledExercises.length || 0} ex`;
                }

                html += `
                    <div class="cal-day ${appointmentClass}" style="gap: 8px; cursor: pointer;" onclick="selectScheduleExerciseDay(${i})">
                        <div class="cal-day-top">
                            <span class="cal-date">${i}<span style="display:block; font-size:0.62rem; color: var(--text-muted);">${formatScheduleDate(scheduledDate)}</span></span>
                            <div class="cal-status ${appType ? 'status-pending' : ''}"></div>
                        </div>
                        <div class="cal-day-title" style="color: ${appType ? 'var(--primary-dark)' : 'var(--text-main)'};">
                            ${title}
                        </div>
                        <div class="cal-day-sub">
                            ${subText}
                        </div>
                    </div>
                `;
            }
            cal.innerHTML = html;
            renderScheduleList();
            renderScheduleSessions();
            window.renderSelectedScheduleDayExercises();
        };

        window.toggleAppointment = (code, day) => {
            const data = getCachedPrescription(code) || {};
            if (!data.appointments) data.appointments = appointments;
            const existing = normalizeAppointment(data.appointments[day], day, data);
            
            // Cycle: None -> Telehealth -> Clinic -> Lab -> None
            if (!existing) {
                data.appointments[day] = {
                    type: 'telehealth',
                    time: '09:00',
                    note: '',
                    date: toDateInputValue(getDateForScheduleDay(data, day))
                };
            } else if (existing.type === 'telehealth') {
                data.appointments[day] = { ...existing, type: 'clinic' };
            } else if (existing.type === 'clinic') {
                data.appointments[day] = { ...existing, type: 'lab' };
            } else {
                delete data.appointments[day];
            }
            
            appointments = data.appointments; // update local ref
            localStorage.setItem(`prescription_${code}`, JSON.stringify(data));
            savePatientToFirestore(data).catch((err) => console.warn('Schedule sync skipped:', err));
            renderEditor();
        };

        populateScheduleExerciseControls();
        renderEditor();
        window.renderActiveScheduleEditor = renderEditor;
    };

    window.addScheduleAppointment = () => {
        const code = window.activeSchedulePatientCode;
        if (!code) return;

        const data = getCachedPrescription(code) || {};
        const timelineWeeks = parseInt(data.timeline) || 4;
        const totalDays = timelineWeeks * 7;
        const date = document.getElementById('schedule-date')?.value;
        const time = document.getElementById('schedule-time')?.value || '';
        const type = document.getElementById('schedule-type')?.value || 'telehealth';
        const note = document.getElementById('schedule-notes')?.value.trim() || '';

        if (!date) {
            alert('Please choose a date for this appointment.');
            return;
        }

        const day = getScheduleDayForDate(data, date);
        if (day < 1 || day > totalDays) {
            alert(`Choose a date within this ${timelineWeeks}-week care plan.`);
            return;
        }

        if (!data.appointments) data.appointments = {};
        data.appointments[day] = { type, time, note, date };
        localStorage.setItem(`prescription_${code}`, JSON.stringify(data));
        savePatientToFirestore(data).catch((err) => console.warn('Schedule sync skipped:', err));

        const notesInput = document.getElementById('schedule-notes');
        if (notesInput) notesInput.value = '';
        if (window.renderActiveScheduleEditor) window.renderActiveScheduleEditor();
    };

    window.removeScheduleAppointment = (day) => {
        const code = window.activeSchedulePatientCode;
        if (!code) return;
        const data = getCachedPrescription(code) || {};
        if (data.appointments) {
            delete data.appointments[day];
            localStorage.setItem(`prescription_${code}`, JSON.stringify(data));
            savePatientToFirestore(data).catch((err) => console.warn('Schedule sync skipped:', err));
        }
        if (window.renderActiveScheduleEditor) window.renderActiveScheduleEditor();
    };

    window.openClinicReport = async (type, pxCode) => {
        const cachedPatient = getCachedPrescription(pxCode) || {};
        let patientData = cachedPatient;
        try {
            patientData = await loadPatientPrescriptionFromFirestore(pxCode, cachedPatient.clinicId || getCurrentClinicId()) || cachedPatient;
        } catch (err) {
            console.warn('Patient report sync skipped:', err);
        }

        const savedStats = getLatestSession(patientData) || readJsonStorage(`stats_${pxCode}`, null);
        const injuryText = patientData.injury || type || 'recovery plan';
        const exerciseNames = (patientData.exercises || []).slice(0, 3).map((ex) => ex.title).filter(Boolean);
        const history = getSessionHistory(patientData);
        const timelineWeeks = parseInt(patientData.timeline) || 4;
        const elapsedDays = Math.max(1, Math.ceil((Date.now() - new Date(patientData.createdAt || Date.now())) / 86400000));
        const expectedSessions = Math.max(1, Math.min(timelineWeeks * 5, Math.ceil(elapsedDays * 5 / 7)));

        let flexion = savedStats ? savedStats.flexion : "No session";
        let flexExp = type === 'shoulder' ? ">160°" : type === 'sciatica' ? ">60°" : type === 'knee' ? ">120°" : ">90°";
        let extension = savedStats ? savedStats.extension : "No session";
        let extExp = type === 'shoulder' ? "60°" : type === 'sciatica' ? "25°" : "180°";
        let compliance = history.length ? `${clamp(Math.round((history.length / expectedSessions) * 100), 0, 100)}% (${history.length}/${expectedSessions} Sessions)` : "No sessions logged";
        let smoothness = savedStats?.smoothness ? `${savedStats.smoothness}%` : "Pending";
        let assessment = "";

        if (savedStats) {
            const romBand = savedStats.romPercent >= 80 ? 'near target' : savedStats.romPercent >= 55 ? 'moderately limited' : 'restricted';
            const target = savedStats.targetAreas || 'current prescription';
            const calibrationText = savedStats.calibration?.range ? ` Session was calibrated to a ${savedStats.calibration.range}° patient-specific baseline range before rep tracking.` : '';
            const verificationText = savedStats.verificationStatus ? ` Verification status: ${savedStats.verificationStatus} at ${savedStats.verificationConfidence || '--'}% confidence.` : '';
            assessment = `Patient #PX-${pxCode} is on a ${timelineWeeks}-week ${injuryText} plan. Latest tracked session completed ${savedStats.reps} reps with ${savedStats.romPercent}% ROM, indicating ${romBand} mobility.${calibrationText}${verificationText} Continue focus on ${target}${exerciseNames.length ? ` through ${exerciseNames.join(', ')}` : ''}.`;
        } else {
            assessment = `Patient #PX-${pxCode} has an active ${timelineWeeks}-week ${injuryText} plan${exerciseNames.length ? ` including ${exerciseNames.join(', ')}` : ''}. No tracked biometric session has been synced yet, so the report is awaiting patient motion-analysis data.`;
        }

        activeClinicReportPatient = {
            ...patientData,
            code: pxCode,
            type,
            flexion,
            flexExp,
            extension,
            extExp,
            compliance,
            smoothness,
            assessment
        };

        document.getElementById('clinic-rep-flexion').innerText = flexion;
        document.getElementById('clinic-rep-flexion-exp').innerText = `Expected: ${flexExp}`;
        document.getElementById('clinic-rep-extension').innerText = extension;
        document.getElementById('clinic-rep-extension-exp').innerText = `Expected: ${extExp}`;
        
        // Update the static metrics in the modal if they exist
        const compEl = document.getElementById('clinic-rep-compliance');
        if (compEl) compEl.innerText = compliance;
        const smoothEl = document.getElementById('clinic-rep-smoothness');
        if (smoothEl) smoothEl.innerText = smoothness;

        document.getElementById('clinic-rep-assessment').innerText = assessment;
        renderClinicSessionReview(patientData);

        document.getElementById('clinic-patient-report-modal').style.display = 'flex';
    };

    window.saveClinicReportSettings = async () => {
        clinicReportSettings = {
            ...clinicReportSettings,
            name: document.getElementById('clinic-report-name')?.value.trim() || sessionStorage.getItem('clinic_name') || getCurrentClinicId(),
            contact: document.getElementById('clinic-report-contact')?.value.trim() || ''
        };
        saveClinicReportSettingsToStorage();
        await loadClinicReportSettings();

        // Also push to Firestore if authenticated/authorized
        const clinicId = getCurrentClinicId();
        if (clinicId && clinicId !== 'DEMO-NODE' && clinicId !== 'CYRAXO-TX-01') {
            try {
                const clinicDocRef = doc(db, 'clinics', clinicId);
                await setDoc(clinicDocRef, { clinicSettings: clinicReportSettings }, { merge: true });
                console.log('Synced clinic settings from patient app to Firestore.');
            } catch (err) {
                console.warn('Could not sync settings to Firestore from patient app:', err);
            }
        }
        alert('Clinic report settings saved.');
    };

    document.getElementById('clinic-report-logo')?.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Please upload an image file.');
            return;
        }
        if (file.size > 750000) {
            alert('Use a logo image under 750 KB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            clinicReportSettings.logo = reader.result;
            saveClinicReportSettingsToStorage();
            await loadClinicReportSettings();

            // Sync to Firestore
            const clinicId = getCurrentClinicId();
            if (clinicId && clinicId !== 'DEMO-NODE' && clinicId !== 'CYRAXO-TX-01') {
                try {
                    const clinicDocRef = doc(db, 'clinics', clinicId);
                    await setDoc(clinicDocRef, { clinicSettings: clinicReportSettings }, { merge: true });
                    console.log('Synced logo from patient app to Firestore.');
                } catch (err) {
                    console.warn('Could not sync logo to Firestore from patient app:', err);
                }
            }
        };
        reader.readAsDataURL(file);
    });

    window.downloadActiveClinicReport = () => {
        if (!activeClinicReportPatient) {
            alert('Open a patient report first.');
            return;
        }
        const patient = activeClinicReportPatient;
        const history = getSessionHistory(patient);
        const exercises = patient.exercises || [];
        const patientLabel = patient.externalPatientId || `PX-${patient.code}`;
        const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Progress Report - ${escapeHtml(patientLabel)}</title>
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
        <h1>Patient Progress Report</h1>
        <p><strong>${escapeHtml(patientLabel)}</strong></p>
        <p class="muted">Access Code #PX-${escapeHtml(patient.code)} · Generated ${new Date().toLocaleDateString()}</p>
    </div>
    <div class="clinic-info">
        ${clinicReportSettings.logo ? `<img class="logo" src="${clinicReportSettings.logo}" alt="Clinic logo">` : ''}
        <h3>${escapeHtml(clinicReportSettings.name || getCurrentClinicId())}</h3>
        <p class="muted">${escapeHtml(clinicReportSettings.contact || '')}</p>
    </div>
</header>
<section class="section metrics">
    <div class="metric"><span>Flexion</span><strong>${escapeHtml(patient.flexion)}</strong></div>
    <div class="metric"><span>Extension</span><strong>${escapeHtml(patient.extension)}</strong></div>
    <div class="metric"><span>Smoothness</span><strong>${escapeHtml(patient.smoothness)}</strong></div>
    <div class="metric"><span>Compliance</span><strong>${escapeHtml(patient.compliance)}</strong></div>
</section>
<section class="section">
    <h2>Clinical Assessment</h2>
    <p>${escapeHtml(patient.assessment)}</p>
</section>
<section class="section">
    <h2>Plan</h2>
    <table>
        <thead>
            <tr>
                <th>Exercise</th>
                <th>Prescription</th>
            </tr>
        </thead>
        <tbody>
            ${exercises.length ? exercises.map(ex => `<tr><td><strong>${escapeHtml(ex.title || 'Exercise')}</strong></td><td>${escapeHtml(ex.duration || ex.description || 'As prescribed')}</td></tr>`).join('') : '<tr><td colspan="2">No exercises listed.</td></tr>'}
        </tbody>
    </table>
</section>
<section class="section">
    <h2>Session History</h2>
    <table>
        <thead>
            <tr>
                <th>Date</th>
                <th>Exercise</th>
                <th>ROM</th>
                <th>Reps</th>
                <th>Verification</th>
                <th>Tracking</th>
            </tr>
        </thead>
        <tbody>
            ${history.length ? history.map(session => `<tr><td>${escapeHtml(new Date(session.completedAt || Date.now()).toLocaleDateString())}</td><td><strong>${escapeHtml(session.exerciseTitle || 'Guided Session')}</strong><br><span>${escapeHtml(session.mask || 'Motion mask')}</span></td><td>${escapeHtml(String(session.romPercent ?? '--'))}%</td><td>${escapeHtml(String(session.reps ?? '--'))}</td><td>${escapeHtml(session.verificationStatus || 'review')} · ${escapeHtml(String(session.verificationConfidence ?? session.kinematicConfidence ?? '--'))}%</td><td>${escapeHtml(String(session.trackingQuality ?? '--'))}%</td></tr>`).join('') : '<tr><td colspan="6">No tracked sessions yet.</td></tr>'}
        </tbody>
    </table>
</section>
<footer>This report is generated from CyraxoHealth motion-analysis data and supports clinical review. It does not replace clinician judgment.</footer>
</article>
</body>
</html>`;
        const blob = new Blob([reportHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${patientLabel}-progress-report.html`.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    window.endPatientCameraSession = async () => {
        if (window.patientCamera) {
            window.patientCamera.stop();
            window.patientCamera = null;
        }
        
        document.getElementById('end-session-btn').style.display = 'none';
        document.getElementById('start-session-btn').style.display = 'block';
        document.getElementById('session-instructions').style.display = 'none';
        document.getElementById('session-progress-bar-container').style.display = 'none';
        const verificationEl = document.getElementById('session-verification');
        const verificationNoteEl = document.getElementById('session-verification-note');
        if (verificationEl) verificationEl.innerText = 'Analyzing local kinematics and Gemini consistency...';
        if (verificationNoteEl) verificationNoteEl.innerText = '';
        
        // Accurate Analytics Generation based on Kinematic Data
        let romSpan = 0;
        let romPercent = 0;
        const kinematicVerification = runKinematicVerifier(window.sessionData || {});

        if (window.sessionData && window.sessionData.reps > 0) {
            // Calculate absolute range from flex to ext
            romSpan = Math.abs(window.sessionData.maxAngle - window.sessionData.minAngle);
            const calibratedSpan = window.sessionData.baselineSpan || 130;
            romPercent = Math.min(100, Math.round((romSpan / calibratedSpan) * 100));
        } else if (window.sessionData?.baselineSpan) {
            romSpan = Math.abs((window.sessionData.maxAngle || 0) - (window.sessionData.minAngle || 0));
            romPercent = Math.min(100, Math.round((romSpan / window.sessionData.baselineSpan) * 100));
        }

        if (romPercent < 10) romPercent = 0;

        document.getElementById('session-rom').innerText = romPercent + "%";
        
        // Calculate recovery time dynamically: Higher ROM = Less recovery time
        const weeksLeft = Math.max(0.5, ((100 - romPercent) / 10)).toFixed(1);
        document.getElementById('session-time').innerText = weeksLeft + " Weeks";
        
        // Dynamic Target Areas
        const currentCode = sessionStorage.getItem('clinic_code');
        const localData = getCachedPrescription(currentCode) || {};
        const type = (localData.injury || "").toLowerCase();
        let targetAreas = "General Mobility, Core Stability";
        
        if (type.includes("knee") || type.includes("acl")) targetAreas = "VMO Activation, Terminal Knee Extension";
        else if (type.includes("shoulder") || type.includes("rotator")) targetAreas = "Scapular Retraction, Internal Rotation";
        else if (type.includes("sciatica") || type.includes("disc") || type.includes("spine")) targetAreas = "Lumbar Extension, Sciatic Nerve Glide";
        else if (type.includes("plantar") || type.includes("ankle") || type.includes("foot")) targetAreas = "Achilles Flexibility, Plantar Fascia Release";
        else if (type.includes("elbow") || type.includes("tennis") || type.includes("wrist")) targetAreas = "Eccentric Wrist Extension, Supination";
        else if (type.includes("neck") || type.includes("cervical")) targetAreas = "Deep Neck Flexors, Upper Trapezius Release";

        document.getElementById('session-targets').innerText = targetAreas;

        if (currentCode) {
	            const sessionStats = {
	                flexion: window.sessionData?.reps > 0 ? Math.round(window.sessionData.minAngle) + "°" : "Not captured",
	                extension: window.sessionData?.reps > 0 ? Math.round(window.sessionData.maxAngle) + "°" : "Not captured",
	                romPercent,
	                reps: window.sessionData?.reps || 0,
	                smoothness: kinematicVerification.consistency || Math.min(98, Math.max(0, romPercent + 8)),
	                trackingQuality: window.sessionData?.totalFrames ? Math.round((window.sessionData.qualityFrames / window.sessionData.totalFrames) * 100) : null,
                    kinematicConfidence: kinematicVerification.confidence,
                    kinematicConsistency: kinematicVerification.consistency,
                    kinematicFlags: kinematicVerification.flags,
                    mask: window.sessionData?.maskLabel || getRelevantBodyLabel(type),
	                targetAreas,
                exerciseTitle: document.getElementById('current-exercise-name')?.innerText || 'Guided Session',
                calibration: window.sessionData?.baselineSpan ? {
                    minAngle: Math.round(window.sessionData.calibratedMin),
                    maxAngle: Math.round(window.sessionData.calibratedMax),
                    range: Math.round(window.sessionData.baselineSpan),
                    lowThreshold: Math.round(window.sessionData.lowThreshold),
                    highThreshold: Math.round(window.sessionData.highThreshold)
                } : null,
                completedAt: new Date().toISOString()
            };
            const geminiVerification = await window.ptAI.verifyMotionSession({
                session: sessionStats,
                telemetry: kinematicVerification,
                frames: window.sessionData?.frameSnapshots || [],
                exerciseTitle: sessionStats.exerciseTitle,
                injury: localData.injury || ''
            });
            const verifiedRom = geminiVerification?.estimatedRomPercent;
            if (Number.isFinite(verifiedRom) && Math.abs(verifiedRom - sessionStats.romPercent) <= 12) {
                sessionStats.romPercent = Math.round((sessionStats.romPercent + verifiedRom) / 2);
                document.getElementById('session-rom').innerText = sessionStats.romPercent + "%";
            }
            sessionStats.geminiVerification = geminiVerification;
            sessionStats.verificationStatus = geminiVerification?.agreement || 'review';
            sessionStats.verificationConfidence = geminiVerification?.confidence || kinematicVerification.confidence;
            if (verificationEl) {
                verificationEl.innerText = `${sessionStats.verificationStatus.toUpperCase()} · ${sessionStats.verificationConfidence}% confidence`;
                verificationEl.style.color = sessionStats.verificationStatus === 'consistent' ? '#10B981' : '#F59E0B';
            }
            if (verificationNoteEl) verificationNoteEl.innerText = geminiVerification?.notes || 'Local kinematic verification completed.';
            const updatedPlan = {
                ...localData,
                code: currentCode,
                clinicId: localData.clinicId || sessionStorage.getItem('patient_clinic_id') || getCurrentClinicId(),
                latestSession: sessionStats,
                sessionHistory: [sessionStats, ...(localData.sessionHistory || [])].slice(0, 30)
            };
            cachePrescription(updatedPlan);
            localStorage.setItem(`stats_${currentCode}`, JSON.stringify(sessionStats));
            savePatientSessionToFirestore(updatedPlan);
            renderPatientProgress(updatedPlan);
        } else {
            if (verificationEl) {
                verificationEl.innerText = `${kinematicVerification.confidence}% local confidence`;
                verificationEl.style.color = kinematicVerification.confidence >= 70 ? '#10B981' : '#F59E0B';
            }
            if (verificationNoteEl) verificationNoteEl.innerText = kinematicVerification.flags.length
                ? kinematicVerification.flags.join(' · ')
                : 'Local kinematic verification completed.';
        }

        // Show completion modal
        document.getElementById('session-complete-modal').style.display = 'flex';
        
        window.sessionData = null; // Clean up
    };

    window.closeSessionCompleteModal = () => {
        document.getElementById('session-complete-modal').style.display = 'none';
    };

    window.startClinicCameraSession = () => {
        if (window.clinicCamera) return; // Prevent multiple instances

        const videoElement = document.getElementById('clinic-video');
        const canvasElement = document.getElementById('output-canvas');
        const canvasCtx = canvasElement.getContext('2d');
        const statusOverlay = document.getElementById('status-overlay');

        if (!videoElement || !canvasElement) return;
        if (!window.Pose || !window.Camera) {
            statusOverlay.innerText = "Motion engine failed to load. Refresh the page and try again.";
            statusOverlay.style.display = 'flex';
            renderClinicAnalysisState(null, 'Motion engine is unavailable. Check network access to the MediaPipe CDN or refresh.');
            return;
        }

        statusOverlay.innerText = "Calibrating Sensors...";
        statusOverlay.style.display = 'flex';
        const cameraBtn = document.getElementById('clinic-camera-toggle');
        if (cameraBtn) cameraBtn.innerText = 'Stop Clinic Camera';

        const pose = new window.Pose({locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
        }});

	        pose.setOptions({
	            modelComplexity: 2,
	            smoothLandmarks: true,
	            minDetectionConfidence: 0.7,
	            minTrackingConfidence: 0.7
	        });

	        window.clinicCalibration = {
	            profileType: document.getElementById('profile-type')?.value || 'side',
	            samples: [],
	            requiredSamples: 30
	        };

        pose.onResults((results) => {
            statusOverlay.style.display = 'none';
            canvasCtx.save();
            if(canvasElement.width !== videoElement.videoWidth) {
                canvasElement.width = videoElement.videoWidth;
                canvasElement.height = videoElement.videoHeight;
            }
            canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
            canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
            
            if (results.poseLandmarks) {
                drawPoseOverlay(canvasCtx, results.poseLandmarks, getPoseConnections(), {
                    connectorColor: '#FBBF24',
                    landmarkColor: '#FFFFFF',
                    lineWidth: 5,
                    radius: 4
                });

	                const profileType = document.getElementById('profile-type')?.value || 'side';
	                if (window.clinicCalibration?.profileType !== profileType) {
	                    window.clinicCalibration = { profileType, samples: [], requiredSamples: 30 };
	                }
	                const analysis = analyzeClinicPose(results.poseLandmarks, profileType);
	                if (analysis) {
	                    window.clinicCalibration.samples.push(analysis);
	                    if (window.clinicCalibration.samples.length > window.clinicCalibration.requiredSamples) {
	                        window.clinicCalibration.samples.shift();
	                    }
	                    const calibrated = window.clinicCalibration.samples.length >= window.clinicCalibration.requiredSamples;
	                    const averaged = getAverageClinicAnalysis(window.clinicCalibration.samples) || analysis;
	                    const stableAnalysis = calibrated ? {
	                        ...averaged,
	                        alert: `${analysis.alert} · calibrated ${window.clinicCalibration.samples.length}/${window.clinicCalibration.requiredSamples}`
	                    } : {
	                        ...averaged,
	                        alert: `Calibrating clinic model ${window.clinicCalibration.samples.length}/${window.clinicCalibration.requiredSamples}`
	                    };
	                    document.getElementById('metric-overall').innerText = `${stableAnalysis.overall}/100`;
	                    document.getElementById('metric-cervical').innerText = analysis.cervical;
	                    document.getElementById('metric-cervical').style.color = stableAnalysis.overall >= 75 ? "#10B981" : "#F59E0B";
	                    const thoracicMetric = document.getElementById('metric-thoracic');
	                    const pelvicMetric = document.getElementById('metric-pelvic');
	                    if (thoracicMetric) thoracicMetric.innerText = analysis.thoracic;
	                    if (pelvicMetric) pelvicMetric.innerText = analysis.pelvic;
	                    statusOverlay.innerText = stableAnalysis.alert;
	                    renderClinicAnalysisState(stableAnalysis);
	                }
            } else {
                renderClinicAnalysisState(null, 'No body landmarks detected. Step fully into frame with shoulders and hips visible.');
            }
            canvasCtx.restore();
        });

        window.clinicCamera = new window.Camera(videoElement, {
            onFrame: async () => {
                await pose.send({image: videoElement});
            },
            width: 640,
            height: 480,
            facingMode: window.clinicFacingMode
        });
        
        window.clinicCamera.start().then(() => {
            applyWideCameraMode(videoElement, window.clinicWideCamera).catch(console.warn);
            updateWideCameraButton('clinic-wide-toggle', window.clinicWideCamera);
        }).catch(err => {
            statusOverlay.innerText = "Camera Error";
            statusOverlay.style.display = 'flex';
            if (window.clinicCamera) {
                window.clinicCamera.stop();
                window.clinicCamera = null;
            }
            if (cameraBtn) cameraBtn.innerText = 'Start Clinic Camera';
            renderClinicAnalysisState(null, 'Camera permission was denied or the camera could not be opened.');
            console.error(err);
        });
    };

    window.flipClinicCamera = () => {
        window.clinicFacingMode = window.clinicFacingMode === 'user' ? 'environment' : 'user';
        const wasActive = Boolean(window.clinicCamera);
        if (window.clinicCamera) {
            window.clinicCamera.stop();
            window.clinicCamera = null;
        }
        if (wasActive) window.startClinicCameraSession();
    };

    window.toggleClinicWideCamera = () => {
        window.clinicWideCamera = !window.clinicWideCamera;
        updateWideCameraButton('clinic-wide-toggle', window.clinicWideCamera);
        const videoElement = document.getElementById('clinic-video');
        if (window.clinicCamera) {
            applyWideCameraMode(videoElement, window.clinicWideCamera).catch(console.warn);
        }
    };

    window.generateClinicInsight = async () => {
        const insightEl = document.getElementById('clinic-ai-insight');
        const btnEl = document.getElementById('btn-generate-insight');
        if (!insightEl || !btnEl) return;

        if (!window.clinicCalibration || !window.clinicCalibration.samples.length) {
            insightEl.innerText = "Please start the clinic camera and capture patient telemetry first.";
            return;
        }

        const samples = window.clinicCalibration.samples;
        const lastAnalysis = getAverageClinicAnalysis(samples) || samples[samples.length - 1];

        insightEl.innerHTML = "<em>Analyzing biomechanics...</em>";
        btnEl.disabled = true;

        try {
            const summary = await window.ptAI.analyzeLiveSymmetry(lastAnalysis, window.clinicCalibration.profileType);
            insightEl.innerText = summary;
        } catch (err) {
            console.error("Insight generation failed:", err);
            insightEl.innerText = "Error generating AI assessment.";
        } finally {
            btnEl.disabled = false;
        }
    };

    window.openExercise = (index) => {
        const ex = Array.isArray(window.currentExercises)
            ? window.currentExercises[Number(index)]
            : null;
        if (!ex) return;

        document.getElementById('ex-modal-icon').innerText = ex.icon || '+';
        document.getElementById('ex-modal-title').innerText = ex.title || 'Exercise';
        document.getElementById('ex-modal-desc').innerText = ex.description || 'Move slowly and stay within a comfortable range.';
        const durationEl = document.getElementById('ex-modal-duration');
        const focusEl = document.getElementById('ex-modal-focus');
        if (durationEl) durationEl.innerText = `Duration: ${ex.duration || 'As prescribed'}`;
        if (focusEl) focusEl.innerText = `Focus: ${ex.target || ex.category || 'Controlled movement'}`;
        
        const stepsContainer = document.getElementById('ex-modal-steps');
        
        const stepsToRender = getExerciseInstructions(ex);

        stepsContainer.innerHTML = stepsToRender.map(s => `<li>${escapeHtml(s)}</li>`).join('');
        
        // Set global references for the session tracker
        window.activeSessionDesc = ex.description;
        window.activeSessionSteps = stepsToRender;

        const nameSpan = document.getElementById('current-exercise-name');
        if (nameSpan) nameSpan.innerText = ex.title;

        document.getElementById('exercise-details-modal').style.display = 'flex';
        document.body.classList.add('modal-open');
    };

    window.closeExerciseModal = () => {
        document.getElementById('exercise-details-modal').style.display = 'none';
        document.body.classList.remove('modal-open');
    };

    window.startExerciseFromModal = () => {
        window.closeExerciseModal();
        
        // Smooth scroll to the camera view
        const canvasContainer = document.getElementById('patient-output-canvas');
        if (canvasContainer) {
            canvasContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        
        // Start the camera automatically
        window.startPatientCameraSession();
    };
});
