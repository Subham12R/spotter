#!/usr/bin/env python
import os
import sys
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Activate the virtual environment and run: pip install -r requirements.txt"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
