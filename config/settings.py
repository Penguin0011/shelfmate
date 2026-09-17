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
FIREWORKS_API_KEY = os.getenv('FIREWORKS_API_KEY', '')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY', '')
AUTH_PASSWORD_VALIDATORS = [ {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'}, {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'} ]

FIREWORKS_MODEL = os.getenv('FIREWORKS_MODEL', 'accounts/fireworks/models/glm-5p3-flash')
# Recognition limits reasoning; search uses its own independently configurable setting.
FIREWORKS_EXTRA = {'reasoning_effort': v} if (v := os.getenv('FIREWORKS_REASONING_EFFORT', 'high')) else {}
FIREWORKS_SEARCH_MODEL = os.getenv('FIREWORKS_SEARCH_MODEL', 'accounts/fireworks/models/glm-5p3-flash')
FIREWORKS_SEARCH_EXTRA = {'reasoning_effort': e} if (e := os.getenv('FIREWORKS_SEARCH_REASONING_EFFORT', '')) else {}
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-3.1-flash-lite')
# Pin a vision model; the generic free router may select a non-generative classifier.
OPENROUTER_MODEL = os.getenv('OPENROUTER_MODEL', 'dots-studio/dots-3-note-preview:free')
# Large batches can exceed 20k output tokens; a length-truncated reply is discarded.
AI_MAX_TOKENS = int(os.getenv('AI_MAX_TOKENS', '32000'))
AI_SEARCH_BUDGET = int(os.getenv('AI_SEARCH_BUDGET', '300000'))
AI_PROVIDER_TIMEOUT = int(os.getenv('AI_PROVIDER_TIMEOUT', '120'))
AI_TOTAL_TIMEOUT = int(os.getenv('AI_TOTAL_TIMEOUT', '150'))
