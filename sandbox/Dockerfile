# Compute sandbox for agent-written Python. Run with --network none (see src/sandbox.ts).
FROM python:3.12-slim
RUN pip install --no-cache-dir numpy scipy sympy scikit-learn
RUN useradd -m -u 10001 agent
USER agent
WORKDIR /work
