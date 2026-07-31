"""
bootstrap_admin.py — one-time script to create the FIRST admin account.

Why this exists: admin accounts are normally created by an existing admin
generating an invite code (see /api/auth/create-invite-code in app.py).
But the very first admin can't be invited by anyone — there's no admin yet.
This script uses the Admin SDK directly (same serviceAccountKey.json the
backend uses) to set the 'admin' custom claim on an existing Firebase Auth
account, bypassing the invite-code flow entirely.

Run this ONCE, manually, from a trusted machine — never expose this logic
as an HTTP endpoint, or anyone could call it and self-promote to admin.

Usage:
    1. Make sure the person already signed up normally in the app first
       (so the Firebase Auth account exists).
    2. python bootstrap_admin.py their-email@example.com
"""

import sys
from datetime import datetime

import firebase_admin
from firebase_admin import credentials, auth, firestore

FIREBASE_CRED_PATH = "./serviceAccountKey.json"


def main():
    if len(sys.argv) != 2:
        print("Usage: python bootstrap_admin.py <email>")
        sys.exit(1)

    email = sys.argv[1].strip()

    cred = credentials.Certificate(FIREBASE_CRED_PATH)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    try:
        user = auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        print(f"No Firebase Auth account found for '{email}'.")
        print("Ask them to sign up in the app first (Daftar), then re-run this script.")
        sys.exit(1)

    auth.set_custom_user_claims(user.uid, {"role": "admin"})
    db.collection("users").document(user.uid).set({
        "uid":        user.uid,
        "email":      email,
        "role":       "admin",
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }, merge=True)

    print(f"✅ {email} (uid: {user.uid}) is now an admin.")
    print("They need to log out and log back in (or refresh their ID token)")
    print("in the app before the app.js UI will treat them as admin.")


if __name__ == "__main__":
    main()