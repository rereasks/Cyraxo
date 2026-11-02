/**
 * CyraxoHealth - Clinic Onboarding Utility (Backup Mirror)
 * 
 * Replicated automatically to maintain parity.
 */

// Ensure dependencies are installed
try {
    require.resolve('firebase-admin');
} catch (e) {
    console.log('📦 Dependency "firebase-admin" is missing. Installing automatically...');
    const execSync = require('child_process').execSync;
    try {
        execSync('npm install firebase-admin', { stdio: 'inherit', cwd: __dirname });
        console.log('✅ Dependency installed successfully!\n');
    } catch (installErr) {
        console.error('❌ Failed to auto-install "firebase-admin". Please run: npm install firebase-admin');
        process.exit(1);
    }
}

const admin = require('firebase-admin');
const path = require('path');

// 1. Initialize Firebase Admin SDK
try {
    const serviceAccount = require(path.join(__dirname, 'service-account.json'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (err) {
    console.error('========================================================================');
    console.error('❌ Error: Missing or invalid "service-account.json" credential file.');
    console.error('========================================================================');
    console.error('To run this script, please:');
    console.error('1. Go to Firebase Console > Project Settings > Service accounts.');
    console.error('2. Click "Generate new private key" and download the JSON file.');
    console.error('3. Save it as "service-account.json" inside: posture-app/scratch/');
    console.error('========================================================================\n');
    process.exit(1);
}

const db = admin.firestore();
const auth = admin.auth();

// 2. Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
    console.log('Usage: node provision_clinic.js <CLINIC_ID> <CONTACT_EMAIL> <PASSWORD> "<CLINIC_NAME>"');
    console.log('Example: node provision_clinic.js CYRAXO-TX-02 practitioner@eastside.com SecurePass123 "Eastside Posture Care"\n');
    process.exit(1);
}

const clinicIdRaw = args[0];
const contactEmail = args[1];
const password = args[2];
const clinicName = args[3];

// Normalize Clinic ID (e.g. CYRAXO-TX-02)
const clinicId = clinicIdRaw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
const CLINIC_AUTH_DOMAIN = 'clinics.cyraxo.internal';
const authEmail = `${clinicId.toLowerCase()}@${CLINIC_AUTH_DOMAIN}`;

if (!/^CYRAXO-[A-Z]{2}-\d{2,}$/.test(clinicId)) {
    console.error(`❌ Error: Invalid Clinic ID format "${clinicId}". Must match e.g. "CYRAXO-TX-02"`);
    process.exit(1);
}

async function provisionClinic() {
    console.log('====================================================');
    console.log(`🤖 Provisioning Clinic: ${clinicName}`);
    console.log(`   - Clinic ID (Auth UID): ${clinicId}`);
    console.log(`   - Auth Login Email:     ${authEmail}`);
    console.log(`   - Contact Email:        ${contactEmail}`);
    console.log('====================================================\n');

    try {
        // Step 1: Create Auth profile with exact Clinic ID as the UID
        console.log('Step 1: Registering Firebase Authentication profile...');
        let authUser;
        try {
            authUser = await auth.createUser({
                uid: clinicId,
                email: authEmail,
                password: password,
                displayName: clinicName,
                disabled: false
            });
            console.log(`✅ Auth user registered successfully! (UID: ${authUser.uid})`);
        } catch (authErr) {
            if (authErr.code === 'auth/uid-already-exists' || authErr.code === 'auth/email-already-in-use') {
                console.log(`ℹ️ Auth user profile already exists. Updating credentials...`);
                authUser = await auth.updateUser(clinicId, {
                    password: password,
                    displayName: clinicName
                });
                console.log(`✅ Auth user credentials updated.`);
            } else {
                throw authErr;
            }
        }

        // Step 2: Initialize the settings document in Firestore under /clinics/{clinicId}
        console.log('\nStep 2: Creating Firestore settings document...');
        const clinicDocRef = db.collection('clinics').doc(clinicId);
        
        await clinicDocRef.set({
            clinicId: clinicId,
            subscriptions: ['posture', 'hair'], // Grant diagnostic licenses by default
            clinicSettings: {
                name: clinicName,
                contact: contactEmail,
                address: "Not configured yet. Update in settings page.",
                logo: "" // Can be uploaded as base64 in the clinician settings portal
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`✅ Firestore settings initialized at: /clinics/${clinicId}`);

        // Step 3: Create a default clinic access key
        console.log('\nStep 3: Creating clinic access key for patient connections...');
        const keyRef = db.collection('clinic_keys').doc(`${clinicId}-KEY`);
        await keyRef.set({
            clinicId: clinicId,
            status: 'Active',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Default clinic key provisioned: "${clinicId}-KEY"`);

        console.log('\n====================================================');
        console.log('🎉 CLINIC ONBOARDING COMPLETED SUCCESSFULLY!');
        console.log('====================================================');
        console.log(`Your clinician can now sign in on the portal with:`);
        console.log(`- Clinic ID: ${clinicId}`);
        console.log(`- Password:  ${password}`);
        console.log('====================================================\n');

    } catch (err) {
        console.error('❌ Onboarding failed:', err.message);
        process.exit(1);
    }
}

provisionClinic();
