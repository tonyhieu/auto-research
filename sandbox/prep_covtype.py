# Build-time only: cache UCI Covertype (581,012 rows, 7 long-tailed classes), since the sandbox has no network.
import gzip
import io
import urllib.request

import numpy as np

URL = "https://archive.ics.uci.edu/ml/machine-learning-databases/covtype/covtype.data.gz"
raw = np.loadtxt(io.BytesIO(gzip.decompress(urllib.request.urlopen(URL, timeout=300).read())), delimiter=",", dtype=np.int64)
num = raw[:, :10].astype(np.float64)
X_num = ((num - num.mean(0)) / num.std(0)).astype(np.float32)
wild = raw[:, 10:14].argmax(1)
soil = raw[:, 14:54].argmax(1)
y = raw[:, 54] - 1
num_names = np.array(["elevation", "aspect", "slope", "h_dist_hydro", "v_dist_hydro", "h_dist_road", "hillshade_9am", "hillshade_noon", "hillshade_3pm", "h_dist_fire"])
class_names = np.array(["spruce_fir", "lodgepole_pine", "ponderosa_pine", "cottonwood_willow", "aspen", "douglas_fir", "krummholz"])
np.savez_compressed("/data/covtype.npz", X_num=X_num, wild=wild, soil=soil, y=y, num_names=num_names, class_names=class_names)
print(X_num.shape, np.bincount(y), np.bincount(wild))
