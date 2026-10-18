# Local geometry runtime dependency provenance

Checked 2026-10-18 from official PyPI release JSON, metadata only. No wheel was downloaded or installed in this check. Versions match the already installed local runtime used for generated-image and screenshot geometry tests.

Runtime: CPython 3.12 x64, set up through [GitHub actions/setup-python](https://github.com/actions/setup-python/tree/v5), which uses the runner tool cache or official GitHub Python distributions. Python is under the [PSF license](https://docs.python.org/3/license.html); the setup action uses MIT. Dependency installation is job-local, no persistent credential or permission is added.

## Pillow 12.3.0

- Official release metadata: https://pypi.org/pypi/Pillow/12.3.0/json
- License: MIT-CMU
- Python requirement: `>=3.10`
- Required runtime dependencies: `none`
- Wheel: `pillow-12.3.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`
- Size: 6,940,830 bytes
- SHA-256: `78cb2c6865a35ab8ff8b75fd122f6033b92a62c82801110e48ddd6c936a45d91`
- Official file: https://files.pythonhosted.org/packages/84/21/a35af28dcc61f37ed850a2d64c65c701321dfbf25085e469d5559360cbbf/pillow-12.3.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
- Release not yanked at inspection.

## numpy 2.3.5

- Official release metadata: https://pypi.org/pypi/numpy/2.3.5/json
- License: BSD-3-Clause (project; binary wheel retains bundled third-party license notices)
- Python requirement: `>=3.11`
- Required runtime dependencies: `none`
- Wheel: `numpy-2.3.5-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`
- Size: 16,606,086 bytes
- SHA-256: `0d8163f43acde9a73c2a33605353a4f1bc4798745a8b1d73183b28e5b435ae28`
- Official file: https://files.pythonhosted.org/packages/b6/23/2a1b231b8ff672b4c450dac27164a8b2ca7d9b7144f9c02d2396518352eb/numpy-2.3.5-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
- Release not yanked at inspection.

## scipy 1.17.0

- Official release metadata: https://pypi.org/pypi/scipy/1.17.0/json
- License: BSD-3-Clause (project; binary wheel retains bundled third-party license notices)
- Python requirement: `>=3.11`
- Required runtime dependencies: `numpy<2.7,>=1.26.4`
- Wheel: `scipy-1.17.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`
- Size: 35,009,148 bytes
- SHA-256: `9eeb9b5f5997f75507814ed9d298ab23f62cf79f5a3ef90031b1ee2506abdb5b`
- Official file: https://files.pythonhosted.org/packages/d1/fe/66d73b76d378ba8cc2fe605920c0c75092e3a65ae746e1e767d9d020a75a/scipy-1.17.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
- Release not yanked at inspection.

## Installation and fallback

Total cold wheel payload: **58,556,064 bytes (55.84 MiB)**, plus registry metadata and Python if absent from the hosted runner tool cache. Installation wall time has not yet been measured on the production runner. Python setup and package install/self-check each have a three-minute cap (at most six minutes of additional preparation before normal scan fallback); pip's wheel cache may reduce later transfer, but that is not a latency guarantee.

Fixed versions, one compatible wheel hash each, `--only-binary=:all: --no-deps --require-hashes`, and the explicit official PyPI index follow [pip secure-install guidance](https://pip.pypa.io/en/stable/topics/secure-installs/). SciPy's `numpy>=1.26.4,<2.7` requirement is satisfied by 2.3.5; all three support Python 3.12. Only the three stated runtime packages are installed, no development extras or models.

The normal production writer permits only these two optional setup/self-check steps to fail without aborting scanning. Readiness stays zero on failure, so original thumbnail selection runs. Source collection, restored state, publication and product acceptance are still blocking; no such failure is converted into success. CI has no continue-on-error and requires the real generated-image self-check to pass before full regression.
