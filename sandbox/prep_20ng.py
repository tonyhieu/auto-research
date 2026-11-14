# Build-time only: cache 20 Newsgroups and precompute embeddings, since the sandbox has no network.
import numpy as np
from sklearn.datasets import fetch_20newsgroups
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

d = fetch_20newsgroups(subset="all", remove=("headers", "footers", "quotes"), data_home="/data/sklearn")
keep = np.array([len(t.split()) >= 5 for t in d.data])
docs = [t for t, k in zip(d.data, keep) if k]
fine = d.target[keep]
tfidf = TfidfVectorizer(sublinear_tf=True, stop_words="english", min_df=3, max_df=0.5, max_features=30000).fit_transform(docs)
X = normalize(TruncatedSVD(100, random_state=0).fit_transform(tfidf)).astype(np.float32)
names = np.array(d.target_names)
coarse_of = {"comp": "comp", "rec": "rec", "sci": "sci", "talk": "talk", "alt": "religion", "soc": "religion", "misc": "misc"}
coarse_names = np.array(sorted(set(coarse_of.values())))
coarse = np.array([np.searchsorted(coarse_names, coarse_of[names[f].split(".")[0]]) for f in fine])
np.savez_compressed("/data/20ng.npz", X=X, fine=fine, coarse=coarse, fine_names=names, coarse_names=coarse_names)
print(X.shape, np.bincount(coarse), coarse_names)
