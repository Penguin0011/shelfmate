import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
# Local-only KEY=value file; process environment takes precedence. No shell evaluation.
if (BASE_DIR / '.env').exists():
    for line in (BASE_DIR / '.env').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip())
DEBUG = os.getenv('DEBUG', '0') == '1'
SECRET_KEY = os.getenv('SECRET_KEY', '')
if not SECRET_KEY:
    raise ImproperlyConfigured('Set SECRET_KEY in environment or local .env')
ALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,box.clouddev.dad').split(',')
CSRF_TRUSTED_ORIGINS = ['https://box.clouddev.dad']
INSTALLED_APPS = ['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'django.contrib.staticfiles', 'inventory']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware', 'whitenoise.middleware.WhiteNoiseMiddleware', 'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware', 'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware']
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'APP_DIRS': True}]
DATA_DIR = Path(os.getenv('DATA_DIR', BASE_DIR / 'data'))
DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
PHOTO_ROOT = DATA_DIR / 'drafts'
# ponytail: one VM and short writes; move to PostgreSQL if lock contention appears.
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': DATA_DIR / 'inventory.sqlite3', 'OPTIONS': {'timeout': 10, 'transaction_mode': 'IMMEDIATE'}}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
USE_TZ = True
TIME_ZONE = 'UTC'
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SECURE = not DEBUG
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_CONTENT_TYPE_NOSNIFF = True
# Enable only when ingress is restricted to a proxy that replaces this header.
if os.getenv('TRUST_PROXY', '0') == '1':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
DATA_UPLOAD_MAX_MEMORY_SIZE = 26 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 0
NVIDIA_API_KEY = os.getenv('NVIDIA_API_KEY', '')
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY', '')
AUTH_PASSWORD_VALIDATORS = [ {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'}, {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'} ]

NVIDIA_MODEL = os.getenv('NVIDIA_MODEL', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')
# Pin the fallback model rather than using OpenRouter's 'openrouter/free' routing alias, which
# resolves to a different model per call -- including nvidia/nemotron-3.5-content-safety, a
# moderation classifier that answers 'User Safety: safe' and can never return inventory JSON.
# Deliberately not the NVIDIA primary's model, so the fallback fails independently.
# Verified 5/5 on four 1536px photos at 7.6-15.6 s; inclusionai/ling-3.0-flash-vl:free also
# passed 5/5 (12.6-23.1 s). Free models get rate-limited and retired, so keep this swappable.
OPENROUTER_MODEL = os.getenv('OPENROUTER_MODEL', 'dots-studio/dots-3-note-preview:free')
# Vision replies arrive in one piece after generation, so these budgets cover think-and-generate,
# not just the network. Measured on four 1536px photos: 19-48 s end to end, including failover
# when NVIDIA rate-limits. The old 25 s ceiling sat inside that spread, so analysis failed at random.
# The ceiling is the openresty proxy in front of us, whose proxy_read_timeout defaults to 60 s: past
# that the client gets a gateway 504 whose body is not JSON, losing the "your draft is kept" message.
# So the total stays under 60 s. Raising these means raising proxy_read_timeout on the proxy first.
# Keep the stack ordered: provider < provider+grace < total < analyzing lock < gunicorn < proxy.
AI_PROVIDER_TIMEOUT = int(os.getenv('AI_PROVIDER_TIMEOUT', '45'))
AI_TOTAL_TIMEOUT = int(os.getenv('AI_TOTAL_TIMEOUT', '55'))
