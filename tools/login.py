#!/usr/bin/env python3
"""Sign in to exorgames.com in a real (non-headless) browser and save the
session cookies for the Node CLI.

Credentials come from the OS keyring — macOS Keychain, GNOME Secret Service /
KWallet, or the Windows Credential Locker — so the password is never typed on
every run and never lives in the repo. Only the resulting session cookies are
written, to `.exor-auth.json` (mode 0600, git-ignored).

    python3 tools/login.py             sign in using saved keyring credentials
    python3 tools/login.py --save      prompt once, store in the keyring, sign in
    python3 tools/login.py --manual    open the browser, sign in by hand (2FA)
    python3 tools/login.py --forget    delete the stored credentials

The store uses the classic Shopify customer form (#CustomerEmail /
#CustomerPassword), so a password sign-in is enough; --manual is there for
captchas, code-by-email steps and anything else that needs a human.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from getpass import getpass
from pathlib import Path

SITE = "https://exorgames.com"
LOGIN_URL = f"{SITE}/account/login"
ACCOUNT_URL = f"{SITE}/account"

# Keyring layout: one entry holds the email (so it can be looked up), and the
# password is filed under the email itself.
KEYRING_SERVICE = "exor-cart"
EMAIL_KEY = "exorgames.com:email"

AUTH_PATH = Path(__file__).resolve().parent.parent / ".exor-auth.json"
ENV_EMAIL = "EXOR_EMAIL"
ENV_PASSWORD = "EXOR_PASSWORD"


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------


def keyring_backend():
    """Returns the keyring module, or None when no usable backend exists."""
    try:
        import keyring
        from keyring.backends import fail
    except ImportError:
        return None
    try:
        if isinstance(keyring.get_keyring(), fail.Keyring):
            return None
    except Exception:
        return None
    return keyring


def load_credentials():
    """(email, password) from the keyring, or (None, None)."""
    keyring = keyring_backend()
    if keyring is not None:
        try:
            email = keyring.get_password(KEYRING_SERVICE, EMAIL_KEY)
            if email:
                password = keyring.get_password(KEYRING_SERVICE, email)
                if password:
                    return email, password
        except Exception:
            pass
    email = os.environ.get(ENV_EMAIL)
    password = os.environ.get(ENV_PASSWORD)
    if email and password:
        return email, password
    return None, None


def store_credentials(email: str, password: str) -> bool:
    keyring = keyring_backend()
    if keyring is None:
        print(
            "  ! No usable keyring on this machine, so the password was not saved.\n"
            "    Set EXOR_EMAIL / EXOR_PASSWORD, or pass --cookie to the Node CLI.",
            file=sys.stderr,
        )
        return False
    try:
        keyring.set_password(KEYRING_SERVICE, EMAIL_KEY, email)
        keyring.set_password(KEYRING_SERVICE, email, password)
    except Exception as exc:  # locked keyring, denied prompt, …
        print(f"  ! Could not save to the keyring: {exc}", file=sys.stderr)
        return False
    return True


def forget_credentials() -> int:
    keyring = keyring_backend()
    if keyring is None:
        print("No usable keyring on this machine — nothing to forget.", file=sys.stderr)
        return 1
    email = None
    try:
        email = keyring.get_password(KEYRING_SERVICE, EMAIL_KEY)
        if email:
            keyring.delete_password(KEYRING_SERVICE, email)
        keyring.delete_password(KEYRING_SERVICE, EMAIL_KEY)
    except Exception:
        print("Nothing stored for exorgames.com in the keyring.")
        return 0
    print(f"Removed the stored exorgames.com credentials{' for ' + email if email else ''}.")
    return 0


def prompt_credentials() -> tuple[str, str]:
    if not sys.stdin.isatty():
        raise SystemExit(
            "No terminal to prompt for a password.\n"
            "  Run this in a terminal with --save, set EXOR_EMAIL / EXOR_PASSWORD, "
            "or use `node src/cli.mjs login --cookie \"…\"`."
        )
    print("Sign-in details for exorgames.com (not echoed, not written to disk):")
    email = input("  email: ").strip()
    password = getpass("  password: ")
    if not email or not password:
        raise SystemExit("Both an email and a password are needed.")
    return email, password


# --------------------------------------------------------------------------
# browser
# --------------------------------------------------------------------------


def build_driver(browser: str):
    """A visible browser window. Selenium Manager fetches the driver itself."""
    try:
        from selenium import webdriver
    except ImportError:
        raise SystemExit(
            "Selenium is not installed. Run:\n  pip install -r tools/requirements.txt"
        )

    binary = os.environ.get("EXOR_BROWSER_BINARY")
    try:
        if browser == "firefox":
            options = webdriver.FirefoxOptions()
            if binary:
                options.binary_location = binary
            driver = webdriver.Firefox(options=options)
        else:
            options = webdriver.ChromeOptions()
            if binary:
                options.binary_location = binary
            options.add_argument("--window-size=1280,900")
            # Chrome shows its own "restore pages?" bubble otherwise.
            options.add_argument("--no-first-run")
            driver = webdriver.Chrome(options=options)
    except Exception as exc:
        raise SystemExit(
            "Could not start a browser. Install Chrome or Firefox, or point "
            f"EXOR_BROWSER_BINARY at one.\n  ({type(exc).__name__}: {exc})"
        )
    driver.set_window_size(1280, 900)
    return driver


def sign_in(driver, email: str, password: str, timeout: float = 120.0) -> bool:
    """Fills the Shopify customer form and waits for the account page."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    driver.get(LOGIN_URL)
    wait = WebDriverWait(driver, 30)
    email_box = wait.until(EC.presence_of_element_located((By.ID, "CustomerEmail")))
    email_box.clear()
    email_box.send_keys(email)

    password_box = driver.find_element(By.ID, "CustomerPassword")
    password_box.clear()
    password_box.send_keys(password)

    submit = driver.find_element(
        By.CSS_SELECTOR,
        "#customer_login [type=submit], #customer_login button[type=submit]",
    )
    submit.click()

    return wait_for_account(driver, timeout)


def wait_for_account(driver, timeout: float = 120.0) -> bool:
    """True once the browser is on /account rather than the sign-in form."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        url = driver.current_url.split("?")[0].rstrip("/")
        if url.startswith(ACCOUNT_URL) and not url.endswith("/login") and not url.endswith("/recover"):
            return True
        try:
            errors = driver.find_elements(
                "css selector", ".errors, .form__message--error, #login-form .errors"
            )
            text = " ".join(e.text.strip() for e in errors if e.is_displayed()).lower()
            if "incorrect" in text or "invalid" in text:
                print(f"  ! The store rejected those credentials: {text}", file=sys.stderr)
                return False
        except Exception:
            pass
        time.sleep(0.5)
    return False


# --------------------------------------------------------------------------
# cookies
# --------------------------------------------------------------------------


def save_cookies(driver) -> dict:
    cookies = []
    for cookie in driver.get_cookies():
        domain = cookie.get("domain", "")
        if "exorgames.com" not in domain:
            continue
        cookies.append(
            {
                "name": cookie.get("name"),
                "value": cookie.get("value"),
                "domain": domain,
                "path": cookie.get("path", "/"),
            }
        )
    if not cookies:
        raise SystemExit("The browser had no exorgames.com cookies — did the page load?")

    payload = {
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "selenium",
        "cookies": cookies,
    }
    AUTH_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    try:
        AUTH_PATH.chmod(0o600)
    except OSError:
        pass
    return payload


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Guests get a 302 from /account; following it lands on the login page and
    would make a signed-out session look signed in."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify(cookies) -> tuple[bool, str]:
    """Confirms the cookies still reach /account as a signed-in session."""
    header = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
    request = urllib.request.Request(
        ACCOUNT_URL,
        headers={"Cookie": header, "User-Agent": "exor-cart/1.0"},
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read(60_000).decode("utf-8", "replace")
            # A real account page offers a way out of it; the guest page does not.
            signed_in = response.status == 200 and "/account/logout" in body.lower()
            return signed_in, "account page" if signed_in else "account page without a logout link (guest session?)"
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            return False, "redirected to the sign-in page (guest session)"
        return False, f"HTTP {exc.code}"
    except Exception as exc:
        return False, str(exc)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sign in to exorgames.com and save the session for exor-cart."
    )
    parser.add_argument("--save", action="store_true", help="prompt and store credentials in the keyring")
    parser.add_argument("--manual", action="store_true", help="open the browser and sign in by hand")
    parser.add_argument("--forget", action="store_true", help="delete stored credentials and exit")
    parser.add_argument("--browser", default="chrome", choices=["chrome", "firefox"])
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to wait for sign-in")
    parser.add_argument("--keep-open", action="store_true", help="leave the browser open afterwards")
    args = parser.parse_args()

    if args.forget:
        return forget_credentials()

    if args.manual:
        email, password = None, None
    else:
        email, password = load_credentials()
        if args.save or not email:
            if args.save:
                print("Saving credentials to the system keyring.")
            email, password = prompt_credentials()
            if store_credentials(email, password):
                print("  ✓ stored — later runs won't ask again (python3 tools/login.py --forget to undo)")
        else:
            print(f"Using keyring credentials for {email}.")

    driver = build_driver(args.browser)
    ok = False
    try:
        if args.manual:
            driver.get(LOGIN_URL)
            print(
                "\nSign in in the browser window (finish any 2FA or captcha).\n"
                "This script continues by itself once you reach your account page.\n",
            )
            ok = wait_for_account(driver, args.timeout)
        else:
            print(f"Signing in as {email} …")
            ok = sign_in(driver, email, password, args.timeout)

        if not ok:
            print(
                "Sign-in did not complete. If the store asked for a check the script "
                "cannot fill, re-run with --manual.",
                file=sys.stderr,
            )
            return 1

        payload = save_cookies(driver)
        print(f"  ✓ saved {len(payload['cookies'])} cookies to {AUTH_PATH.name}")
    finally:
        if args.keep_open:
            print("Leaving the browser open (--keep-open).")
        else:
            driver.quit()

    good, where = verify(payload["cookies"])
    print(f"  {'✓' if good else '!'} signed-in check: {where}")
    if not good:
        print("  The saved cookies did not reach your account. Try again, or check the store.", file=sys.stderr)
        return 1
    print("\nDone. `node src/cli.mjs add deck.txt --dry-run` will now work.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
