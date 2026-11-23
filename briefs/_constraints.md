## Constraints

- Class-project scale: experiments must be feasible with small models and modest compute; prefer toy or small-scale analogues that test the core claim.
- The python_run sandbox is CPU-only (numpy, scipy, sympy, scikit-learn; no torch): use it for toy models, simulations, and quick math checks, not LLM training.
- Real data in the sandbox (offline, no network): `/data/20ng.npz` holds 20 Newsgroups (18,144 docs, headers/footers/quotes removed) as `X` (100-d TF-IDF+SVD embeddings, L2-normalized, float32), `fine` (20 newsgroups), `coarse` (6 groups: comp, misc, rec, religion, sci, talk), `fine_names`, `coarse_names`. Raw text: `fetch_20newsgroups(data_home="/data/sklearn", download_if_missing=False)`.
- `/data/covtype.npz` holds UCI Covertype (581,012 rows) as `X_num` (10 continuous features, standardized, float32), `wild` (4 wilderness areas), `soil` (40 soil types), `y` (7 forest cover types with natural priors 36.5/48.8/6.2/0.47/1.6/3.0/3.5%), `num_names`, `class_names`. The rarest class, cottonwood_willow (2,747 rows), occurs only in wilderness area 3. A logistic fit on 20k rows takes about 15 s in the sandbox, so keep pools to tens of thousands of rows.
- These two datasets and pure simulation are the only data available. There is no way to add a dataset, a GPU, or a real LLM from inside a run; a topic that needs any of those cannot be tested here.
