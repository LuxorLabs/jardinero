# Canary: prove the image can install and test this repository. Replace with your
# repository's own gate.
uv sync --frozen
uv run pytest
