# Compute sandbox for agent-written Python. Run with --network none (see src/sandbox.ts).
FROM python:3.12-slim
RUN pip install --no-cache-dir numpy scipy sympy scikit-learn
# 20 Newsgroups, fetched at build time (runtime has no network): raw sklearn cache plus 100-d embeddings.
COPY prep_20ng.py /tmp/prep_20ng.py
RUN mkdir /data && python /tmp/prep_20ng.py && chmod -R a+rX /data
RUN useradd -m -u 10001 agent
USER agent
WORKDIR /work
