// Keras fixtures. The `.keras` archives and the legacy `.h5` model are genuine
// Keras 3.15.1 output (`model.save(...)`, numpy backend, weights zeroed to keep
// them small); the rest are written with h5py/zipfile to reproduce layouts this
// Keras version no longer writes. They are stored gzipped because HDF5 files
// are mostly zero padding.
//
//  - SWAP_KERAS: Functional model whose layers are named `dense_1` then
//    `dense`, while the store names them `dense` then `dense_1` — Keras derives
//    store names from class names, so matching by layer name swaps the two.
//  - CNN_KERAS: compiled Sequential (Conv2D → BatchNormalization → Flatten →
//    Dense named `head`); the store also holds optimizer variables.
//  - NESTED_KERAS: Functional model wrapping a Sequential sub-model, so the
//    store nests `layers/sequential/layers/dense/…`.
//  - OWNED_KERAS: Functional model that owns a variable itself
//    (`Model.add_weight`), which Keras stores at the root of the weight store
//    as `vars/0` rather than under `layers/`.
//  - RNN_KERAS: Sequential with a Bidirectional LSTM, whose one layer holds
//    several sub-objects that each number their variables from zero.
//  - OWNED_LEGACY_H5: the OWNED_KERAS model saved in the legacy HDF5 format,
//    where the model's own variable goes to the reserved
//    `/model_weights/top_level_model_weights` group instead of the store root.
//  - LEGACY_H5: the same Sequential saved in the legacy HDF5 format — root
//    `model_config` / `training_config` / `keras_version` / `backend`, a
//    `/model_weights` group with `layer_names` and per-layer `weight_names`,
//    and an `/optimizer_weights` group.
//  - SUBCLASSED_KERAS: a subclassed `keras.Model` whose children are addressed
//    by attribute name (`hidden/vars/…`, `blocks/dense/vars/…`) rather than
//    through a `layers` container, and which also owns a variable directly.
//  - UNICODE_KERAS: a custom layer class named `Densé`, whose store group name
//    Keras derives with a Unicode-aware snake_case.
//  - NONAME_KERAS: a custom layer that owns its variables directly and whose
//    auto-generated config carries no `name`.
//  - COLLIDE_KERAS: a subclassed model saving one layer as the attribute group
//    `dense/` and another, through its `layers` container, as `layers/dense/` —
//    two different layers that the store addresses with the same leaf name.
//  - BARE_STORE_H5: a subclassed model's `save_weights` output, i.e. a Keras 3
//    store with no archive around it and a model-owned variable at its root.
//  - ROOT_LAYERS_H5: a `save_weights` checkpoint containing a layer literally
//    named `layers`, plus a `top_level_model_weights` group.
//  - SAVE_WEIGHTS_H5: Keras 2 `model.save_weights(path)` — layer groups at the
//    *root* listed by a root `layer_names`, with no model config at all.
//  - CHUNKED_NAMES_H5: `layer_names` split into `layer_names0` / `layer_names1`
//    by `save_attributes_to_hdf5_group`, which writes no unsuffixed attribute
//    once a list passes the 64512-byte object-header limit — here 450 layer
//    names whose combined length crosses it.
//  - WEIGHTS_ONLY_H5: NESTED_KERAS's `model.weights.h5` on its own, the shape a
//    Keras 3 weight store has outside its archive.
//  - PLAIN_H5: an HDF5 file that is not a Keras model at all.

import { gunzipSync } from 'node:zlib';

const SWAP_KERAS =
    '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';

const CNN_KERAS =
    'H4sIACfIf2oC/+0dS2wTR3Q3icGiRYQ2Eh/R1rgqRIi4a8dpSFohAgFCoeDyqaK2aJnsTuyl+3H3ExIQKlJ7SG8cOfTAoao4op44VRw4cKnE' +
    'oQeOHHrosUdu7czsjL07Xm+cDwkm8xRrPPPezJt58+Z9Zh27cra3b0AKYb/0R+Fm/hh6h1/b0cuCPtCBDwrXPce+lf8OusBT56DrGY6dH8/l' +
    'hwvFkUIxfziXR1RQ9cAc1HF7SSl9MqQcGSqOHCsWxxVlXBnN367EWG2/++Gfyk5Jwq+3UIvm2LNGlTKyHD0wIR6JsMQMNBN4nmoDizRfgt8H' +
    '0PYNYBIc6Yvab+UZgWbbGOO7wLDBDBnLdwOIZ+ov1CGhXZLL5GVEWnFMQ1tow2bWdIA/XMrfRmgXVg3Phy7U2QB2YJoI4dUAbnRmrkPNVw0s' +
    'oXJ5+Eh5ZHSkpOCeJlhAMkXN37RMqkBxLXM7Y9cD/xxGclObAb5WUxFPsspvwjl8Qv6Gr0bW35g7nmEduB5unAWmh4XkgmqVbCVrYGwNzFY1' +
    'GV+n7iNVQLtAKdvLAWE6X9wJx54rTbbbWozUX4/dxZhZw/TD7SsfJsxsaKqecZOIf5hK3fNdQ4dkj4uHc0XcVAe6btiYY34OmIZOjxFQZx3X' +
    'Aj5Zag3YaDQPCdzzCd4wAZa46qLzFh2s6jpBHQ+PGvJA8405QocHcaEZ4L6BB9UZA3hNYdG5GraBTxKasZskuUIEnyDG06bjOv4V28DT5gTp' +
    'QaJE9ByEugPmiRhomxP4XGO6sPECVjnhr6HrePGJpvOkYkIEgQlcypXOn8wnEUM2wfAXkrF0TDQFj2ixzw3Zgki1MDOBYepqRPChqNsYgdvL' +
    'OovHsT05j1USCTRUquTTEhoem6fsDhMM5g2sgEP4+FiOhXxLYKG6UhgbQy2w7hkmOU1KQVEwjYYoyH7SJXkaiK5wBjnO9VbTKrCs1TK9YMNl' +
    '8bScOWTCVAsCe72XS1nPoZMFbA2u88LJBiee7HAbko0F7pR05MM+SRhvwdZqrmOjgaLu2IX4nLU0qJpp1OuhU6EDUASn02tgTcrh3zKtySnk' +
    'v3xotz3LDWx3mI1Uf71hQp6ENormktddg0DvHvkG6NBiuzzSEtV4zqxvgXkR2Kx7YLPs0AUhvg8AytbCoKCp9GsV1+DzcbVBnh77rGEYRSRt' +
    '1Q0TRvvglMhqu4MNbML+TejAanOaAEWZELg2dns0/ifhiBJCebQ8NloeKaKUI38DGtWar+pQAwvN9WHvQP0GczymMwNMtRWBW1BWEkSkg48Z' +
    'tEDE6aCamhAsoVZnDro3XMOH6qxLUnUtMg3TQYsmAZM6iw61E3WeLtANNJ4KNC2wAprsoM2qe5wbLYYMWbVE+cejtSIcUkax6bA8PHJHWSqZ' +
    'HjHmSMRVxzU0LCB0sjw0L9epE4NHlhAKOTIxC6IsTyNJXh4vwAVo2Vcb24FYNSmYew5sFYIqdM2FiGDJgtU6dFU4D7WA2jwcd143fJUqHTV3' +
    'tyMXK73TO67u+q28WP5KkvCrH9/hODo0C3SuhdrIz1OTp7Zv27uNdMhmpT5C1YT/KOD+0TrDX6OlTMtFWj7oYe0ywe2m7Tvp+Dzd5YsnT2Lq' +
    '/zhgfF5kwjIrCdiMMHVyooLLaVofpOXTnjgdSgA8XIbBkCQ1LCynp0qHfGWpN6a//VR/B7fG9T/UX6mt/goQ+hvVX2bHFjO8voVQWSO+l85f' +
    'mMQ6zKz64q44n4e0/mxPWDI9/+VsnO4Jrf/9RXz+ud443RSt1zJv1v4xv8Wv723ydASvPyMNIKng6AHX98gy6dHfkE02Jic8zOLWpuxOn7hw' +
    'TpZoB44Og2bbpGTmbgtrJ9ffTbp3aZlw/Uba+yiespZoji2x7WJ4nBhG+bB2HHpG5VLZIc62AAECBAgQIECAAAECBAgQ0Cm0uyfn72eWuifP' +
    'vheWg0KkmxL4e8YjtPx3T5yO3Ru1uydi90I6/vCA1LyPyi1Tf+t7w/rdfZ3pb/9+qsdiK4X+So3rUOnhvjgde87TuHdeJd/wnrz59PPFQabX' +
    'VB+pQR08FNfPqb1xOl7f2XOml5/G6XKfheWxo3F7/awcp3tJ67tHu8WPJT8vm86H9WtSZ3Zg/qP4/gvY3HaA6dMjzgGx81WU4ufm2KrsgNw4' +
    '35X34+PO0/q9nNijNGD+n5fXSp+X4edQ7HlZD+0vRwhk6gHkvrCBPQ/jy7427a343WTonbkPaFtO2pWVdv1A8Rk0P4zv6emRw9mGGtorP/2Q' +
    'eiw5LpFpoRQCODvT07Azj/Lp9MwPPj4gZBePN3g7EJ5DWZZj53n15/rZweSIZLEr7xX4eHapeOzakMjLRDzWmpdNHXq1eVm7fOJBYXn5xKCS' +
    'fn8hYHPpL8u3s0Pp+USJlsNcftHp50f5fOL+ofg4T2n9n8NijzrJJ3h5rTSfeDeST/SuaxyxW+nGOILdjzE9zn7cWbxaL6bTMbt+t5ROx+z2' +
    'w2ERr3amZ3dK3Rmvrpd87g8L+aTJ53H5Tcp3+Hv0peLFyrjId0S82JrvHBndmHzn3qdJ+Y74fyMBnekvs2Mvx3h9o/ZuTePEZr5zdzTO5xGt' +
    'Px8Te9RJvsPLa6X5ztZIvtOX4if559JLPqedEH5S2JlWP3nt6Mb4ycfHk/xke/1VziRHuQI2p/4yfcpNxOle9ecMHh2Nj/uCnZ8JsUed+Ele' +
    'Xiv1k30RP5lJzLfDm2M5TJcb+5/h9CGz6vxbmeSGYh5XbLoAAQIEbADwn9vJnUinZ3Hl/OdCdvH4Pf0eO7NmfnSRfnPJADeDxS6QUXKOzn8X' +
    'y1I5zr4vRY4ucpzWHL3v/Mbk6PrF5eXozy+JHF3ob2uO/qSyvjn6t+fj4/5E679WxB51kqPz8lqLHH1LYizBf9dWP3nfn5UasUN6zPDXpSan' +
    'KNzv2jj1ycXO4tTcFaGv6XEqr1srvt/5KlnH7r3W8nDe+XG8clbuGeht/ztBDO6QFcd+NYjvyv/uT7Prd1LsV4CiHZO+17bZ8cnO1m+5rZzN' +
    'bAl3q1f6HZUHarj2PyTha7nuaAAA';

const NESTED_KERAS =
    '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';

const OWNED_KERAS =
    'H4sIALjUgGoC/+1bT28bRRTftePWKo2aShFpK4u4TlCqkLhOQqOq4hBE0gbFooa2EiKNthN7bC9Z77r7J2kaLDga0Q/AB0CiB06II0IcOPAB' +
    'uCBx4JAjhx44IpX5690Zr53ITUWR58mr8cy8mffmzW/ezL7dLW0kR8Y1Spe1y+c+HF1B//A1iq4G9EEF+CD/qefYB7kd6ALP2IWuZzp27kY2' +
    't5RfuJZfyM1lc4gLGh7YhRVcvlhYXJ4vXJ9fWF4pLN/Av0KuVRJEfftT5vXfU5qGr9dQSdmxq2aNCWo4lcCCuCciMu+55Twqg5aXrwZ22Ufi' +
    'gYXFli3geYYNGoT5plhHekTlBznO4OzZ0MV1vgtMG2wTGb4bQFRkgX00MJTf7JbP6roEvm83A7+IKyWB28Av1w2vDpqYb9MOLGsu+/YWNpS/' +
    'T8pyVcsB/tIibug1gevhwiqwPKyLC2o1YklewAVWIfADFxJVnCYbK2Nr4YawZno+dGGF60hFx3Zg2ttOYCNOZFky8C3UxfEHvwptpHS8oesQ' +
    'VHrYmRugS1CMhLuIteRYZnm/hxxuxN5jxzWBbfp4gEvoP0AI2QU+A7Bl2hCQyQs8aGybwAsVRUrZ0DJM1NgElvkYTXKM1vlIfcwQblmO6/j3' +
    'bLPquA1pEB4kc8xmyMRYMsAjMhWszAl8qbD/QPEAXlDhT6DreKKi/WUyMyGGwAIuk8r0J/rE1rBWSIhHMOJLjeIqHgbA9s3HZPKMjnr9rYL7' +
    'C0yrYkTsTi3dtThbkWXC8du1RA5ywK2xf6LhDIO6Rx8tC8c1DHmyj+kLaCd1NBTH3cf80SVbQL+tVgu33dljihygPCmhwwrdWFfDEFARJjZS' +
    '2nOsGSW3eoQ5+XSUnUbTtGCEsRXZAX4ujG1tPnu48+yqpuFrDG822MHn96BZq/tevn7ty/XVm6NnLp0hDdJpbYRwhfScEW4fzfP6ByzVWdpm' +
    '6dMEL9dJ3QVWfp71L/Pd/WhtDXM/l4jL+TNF07SmaBhpfe3dEk4/ZnmOp18TIt8u2uRxShdfiMuVAeXqWlLA7xjD75XTIv6Pwu93FxR+FX5D' +
    '/HIv206JfAXJn66/oNw7H9xe1bVER97fF8X+M5do+k5GxGc2KenB8vXUcM4f37dkO5xlnkXXUto4sh7eznH+oq6TFmMdG6YFe+Lm7dOhjW+9' +
    'd7uoR4AR5cNEbqpQyt0dnyd+/GBqof2b6YdOHFH9n55Ta1CRIkWKFClSpEiRIkWKFCn6rwnHD/TIjb/OIo66rgtxAJ4mUT2uOZ+dZPf8WW0i' +
    'rU183uFLk/pEIqHTeAHtL6l/zSKR45IG7VfeRjSWpXdiH+0JhZvBsBb/TEaOBR4V0/Ynaapi2sNJckw7y9L7GZEv8syU5Cv4nYbQ1WnXTwi/' +
    'fzC5/7xxPPx+NqXwq/Db/UwmMyny8WeKJ/1MhuN3+k2Oa0pFlrdmRHz+kBH5ZLwP3z4W/2z2l2maf6BF/YDW0w8oUn4g6gf4epuekvFGqfSS' +
    'zrM/ZkU5hyw/MqXmqB/x/V+216DPZnGOP5tN9DlvyH76qPPGN7PqvKH8TPd548nMyz1v9Non/3orbp/sjd8n86LeioYbvxxPxVmRj7/DtCDt' +
    'mysntE8ezoj9nr1C07lZNUfH2Sdlew26T45E9smkFhfDpIJ0GoLsvJskv6uU7KSDxjTvz4vI4/TofzU//L6Q47w415+f++Hf8grb4n7XP5ae' +
    'PDHcHV7lK0ikVzeWXtrQE+PJ3h+jcfqCjFT4NE1uKn9cFjbd0YRPzaIN475JCBs2TnV/oVDaSJ2is5TUvkfpV8s49y+nhPBoUzcAAA==';

const RNN_KERAS =
    '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' +
    'NfW494yzOn7hL5Cay5D7D9Jh+5c6ZwAA';

const OWNED_LEGACY_H5 =
    'H4sIADJegWoC/+1aS28bNxDm6pWN7BQOkCBKW6OKjDY+BLYTOWmQS13UTlQgaIw2BYoExpqSKGnh9a66D9uKYPTq3nLsoT8gxxxz9LHHHnvM' +
    'T+g/cEnuUFpSD6u2DkbCDzYoksPhcDgzS87u75X1x1fyn+YRg2miDJpDSZwAzEdyXfRvQ2lAeQTlm5Roz/K+ArTPAf9iWh74/MeNDVY5UdAT' +
    'BBiYSONjRGXj201W/iKbA/orJdPtenXiWPvEbrbCIGGXa2ec9yrYq2rXs6gC5vsJukatcof4OLD2iB/YnkvbbxoGHznXk8GU/CSXMGaD81uD' +
    '3ybnV8W1HeLWT+WTTfBJSXJd4XxifdQ8t2E3EZcLjeV3nOnzS4/x3/e5uF6c0H/Nz4Fem7L2X4qH4nmRk+kaBIeRTwJRbxFcZ2XotS2H7FFb' +
    'lj1c2G3xFP+tZIBfTvhvC+x+lvpJATm4Q3zLxbsw9Ug/MYyeryVLM+GHzCcziXpmrH+jif07N1HcQRPHnUv0/8l3z54aCAaodBTlpbv3l+72' +
    '15mF0o122x2IEb24QdEt1RwcBFyTpUfF0uPIrYVUNOyU7hRLcRyi7d2SIPD2XeKzvtDHtourDmsN/YjQJr4pAa2/VNl+77aj8CnrVthWcVhr' +
    'WUELtxndSzdynDvF1S1KVA87vK3UcDwclu+xgUEb+wFrbGAnYDP6uNkk9USDmFDYJRvltWFFQHY4gs52q17k1i2XWixfxRalVFeyTlwqwXDd' +
    'MOMfoRqxmm6J+kPEe0rcFjgreYbnlHTTc+xaZ8Q8QiNsIT5p2kFIfFIXDJgOWU/k2iFbRpn+xnRT9zBTAxvv2C7BfCeigFhVGwd9QalQLvVX' +
    'mw62sWO/ojs2ROqlRP+QJTxxPN8Lf3bthufvKosICN+weKepzqlhWPiAKxzavChUGscvlC3gnAK/IL4XyIKOnxPURAkiB/swK8jP5RnaA6Po' +
    'JAG3kVAZNKzj1wi7of2Kb57VE0/IoZregA13S9hvDvVJy4qDUUgt2vMtS92nCX0yZtKievL8DqNP+tQK/ds6PGRjd/ZBkC6t85Z47/tBY2Bg' +
    '3xYSRLBS4AxhDGWU508WyfcPwTo3Ii5eGhFHxfjLCf7LbK+U9plkf7zNvJ6H9utQ8vC5DJvt+4QH28TzbzGvzx4aGhoaGhoaGhp9/PTDs3WD' +
    'ZyUgj5KR8wBq3kRjOAyUHpon3ZwH/aFknhSNfs+hofOkiTyp8Mu3n6n2FmNzqnEg3ZuvclOepw311yCHsPN38zLd+3k5ISvysu0Vme4PqL+7' +
    '92Htn8g3q/qS38sUUJy/7iecrxa/Ad2vodUZtHoCiVWRb5403hyAwo+keDP6vczxgmxnGh93vBFv/4tFmU7kwXrngin5iRov+u9lhvvJ/30v' +
    'M5Mw7svwL+om52FIfiTkWrwF61yYzI8KX2k/0n40+H1Ca0GmE6lckfI97/cJ6vkd3ZKfs6oda4w6v8ffOQjFGWgxLlNxg3gfIN53qvU03XGD' +
    'P8e/gL4iumGiG79Bf5buEOtPpWKGJlhI2ti+HVOsKBIdXIB7Yar3PNheHk8v7M/8UtuShoaGhoaGhj5XyufKgnRfTU/tHPn6trhByzi6YPoY' +
    'nrdaKcun3tPu260H+r6t79uDeat/lHwy/z4KTT9vpeavZ0GSs+atDCTf268njDuPRuep/ga/+ff+ZH5z/FD7jfabwTzV3AOZTv2icNp5qjdl' +
    '2d5VO9Y423ki2zsnnPc88SecJ65d6POEaldvv9Y2chb8B6p4Wg0IOgAA';

const LEGACY_H5 =
    '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';

const SUBCLASSED_KERAS =
    'H4sIAHkTiWoC/+1cPWzbRhTmj+QI+UGUQqidQIhZ2k0NOFb0ExmCkgZKarcCHDRCm6FAG0i0yViMacoVKTeBIzSjii4dO3rMkCEoCmTJ0KGD' +
    'x44dOnjoks1DhgAtkPLIO4l3omNJUVI7fg8gnu7u3Q/vPt59945UaUEMxThPPuCe/bN1vOD8QtcJ51rVbEVVbCVxx6qZG/KKVles8rpWt/Sa' +
    'KeclOZNIZRMp+bwkO1Za2VLWNRXFp5Pp2ZlkbiadLqTS+WQ2f3FWbpaoqqQf/zwW4zkOXcecmKWaeVtfxhWt1tSGoTklmQ3DcEpfMhTLKpvK' +
    'KoqTrxm1pRVUqZfHidqQ7bqim8qim8muNzTUJPvemuYmtovz7kDuKnHupmNaqhn60j2mXGJx26gpdiYtN53kurasW7ZW11RSAGpmMzip09rF' +
    'hm6oZV/ZurnWsMtWVXGb+XXqvJS51XSrX13TDc1n2vR13pPK+7e+3XivWbzCceiKonGqqZqR+E7Tl6u2lahmfyjOfXri6JmjboZIhAu5Vh15' +
    'iQXl94dJegVrHusW1g8FEs+7aWM4/hQun7W7+cX8PLJ+yQipZzvs6QgHchilOH+1hPRXOCxhvSXQdutK3UJ6ET1Lzq+qrqqa2cFnrs96eU6k' +
    '8BvF+J06QuN/L/w+GgP8An47+CWzbCtM2yWZ+bT4mvV++fmNOYRhUt/z03T58TOevhz3NMH53Qxtt4nDv2VpHEsi014crobfrfEj6xZ7f8dd' +
    'BoTuP8zFnF5BazkKn+Z5N0e03TcRqp8QkWkd6fTdZ5/cuM77gOG3a89nZXf1dsNk2iN6EQNHZONTng7h8AjWZF4k0joJzygICAgICAgICAgI' +
    'CAgIyJsW5D/gfRt/HntieN6LIO4UokUnHaWcksbx3l7iRiPc6Pdtu4ibLggC73kfvPJE/mfs4okxLWjt+z7yfFl82/fUGgXcDIa14DMZ1he4' +
    'l0/bHvd0FLr0UArr0yZ4+iZO26maaWlEl1Nt32ZhyPj9C9f779ne8Ht/wtNwJgP49c9j8XHajpwpDvdMRmjj7tc4wTUXiGPSrq0p2m4Hh6PT' +
    'h3UdCz6b/X3SC1e43uYB9RysYzAPdK9jkxO0HTmbTXH0c1h4rXmgw2efSnS5f+NwaALG6FVC1n+2vwY9m0Vnp+RsVgjcm3kTL+9trdpnq+Ts' +
    'lQ0Pvle7eI5GHpG7B2p82PVu8sNX25N5+NFHgO1+fATi0HD3dIo8QQfFR7DbnoDlSHtxgWIC9gTABbr3BMnpN7sn2I3L/nShPy47lgIuC/jt' +
    '5rI7M2+Xy7am6XIf4/AfMzBGvXBZtr+GwWXFHrgs+/5gd3hQTkGgNnYguCzLWXcu9MZZK2nAcD+cVRgavtYywcyttU/7JZivsu9Z77Xev8gB' +
    'X4X1vpuvbmf/H75ayPfHV7cvAV8F/Hbz1c3c2+WruVm63AoOP8jBGPXCV9n+GpSvjvj4aqgPvrq7D3ZQPvH4Eo28/c1Xe+Wxm/neeOzUx4Dt' +
    'fnhsaGi4y10JXhH39/tZpQVeiIm7/z8AkQfu3VL/FsBmZb/372Rd4aiv//0Zg75172R8yHd/+V5aCI94IyVyvzj6rDth/QfSXeME5kAAAA==';

const UNICODE_KERAS =
    'H4sIAAp/iWoC/+1az08TQRSe2bZQUWNJiAjBUFYPHqQp5UcoJgYjKIqRRj2QKClDO7QL293a3UWJaSSeMF48G2P0pjf15JHEi0f/BP8ED95x' +
    'Znem3dl2kYAHDfMlm+m8eW/e2zffzDYzk5uPRHuAhyHw4tXQp2nyiz4nyVPBNioiG6XWLNN4oq7jGrLyG7hmaaahTiXV0dTIeGpEvZhUiRbO' +
    'W2gDF6k8k85MDKcnhzOZ6ZHs1Fh2ajyt1nOCq5uX9GPPIgDQ5ziRFExjVSsxRxWz6OiY9uS6pA4KOrKsvIEqrvgufuhgw9aQ7ra5tkT+ROUK' +
    'jqHRFruGNAOtuH3ZNQfTSO3NKnZ1/+hl5h5RzZm6VtgMcbOqm8gezah10lzDJc2ycQ0XeQeGo+ukwSojKjRX1nDBzms0Q2OT6YnJ8dGJ7AS1' +
    '1NEmySkR328JKsXaWmK7YVQd+xZtDIS2guxCOU98um9534thbMn35o2oaWxVVLOocBXpFk1PDZVK7iByAXeoUYd5nXs0qzYhAck/0wzPAGnx' +
    'vRbLSSDR2LAeOOk0zobkGRUKZLhJXP/EmNIWQjCbDtlYezX1qmPZZuWy+GYrjqYX8z6fXlJbBqteX2poh6nsxbh9+3EzUKlqOvZp131TNfvm' +
    '9NIv/d2XxfMA0CdBVwWziPXUI6yVyraVKo8/n5u5drKrv8s1iMdB1NVqYpeB2vvrvH2ZlZCV26x8r3A5dNvOMHk36z+od+/O7CzV3g2A+/kR' +
    '88o4kDiKmJu9kqPlIqtzPn1TRL0NsiTS0lt6m7ycPqBfCCICfxOMvxc6Rf57/AWh/JWQ/PXzl69j27Eg3zzk/pLfu7cXZiBQGqv6dq/o5yOr' +
    'f+8T40pGRL05Vi/Hjub48e9WMA8n2MoCQQz0kOzRbzmt90HoWiQaOYwL+aTdbHc2c3z96sItCJhBQI+C/GVxSyXAH/7nise5c0rONQkJCQkJ' +
    'CQkJCQkJCQmJfxUQRNvuM8bPenW+HyT3GSX2Qtg+48++IN9EXh2ev+3Pear9Xv3lgJ+/4ec8Z5Ji3BJHm7983/rjgKjHz3ka+9OH9Ks0mNue' +
    'mV2EkdCn38H0YQJ2FLFhff0w1y/Oh/bnRstDXn0Z7G8+JM7J+SDnQ+t82BkU9dKBdf2w88E7N4IN3i2eFfvfYvW3g3KM9gL/DgbzddBzI1rj' +
    '50YKs4c+BQgueKXiCaLMLqyMkBWKanYnB5ksCXrjoPcpa4+xdU9RvA7jbEWLwO+qpzEdeOPH//V4BXm/MyQ5fBDk5qHSEwm/ncix5bJKuKsY' +
    'NA3eNmyargPh7qHfsN3dp6bh6WjrTajcfKzDmxER8JmUr92J9BvFG4BiZCkAAA==';

const NONAME_KERAS =
    'H4sIAAp/iWoC/+1azU8TQRSf7VJpUCIkjXwEtawfQYWmH0CQg0EBxUBsIxxICCnTdmgXtt26u0UIafTgAW8mXjyZePOInjh65Oif4H8gF884' +
    'szvT7mwpEMRIZH7JZjrz3pv35s1vZ2FmktNyUxA46AU9v/aCY/gXeVrxU0AWzEILhldMvbiprCIDmqk1ZJiqXlRGQ0o8HB0KR5X+kIK1UMqE' +
    'ayhL2mOR2PBAZGQgFhuL3h8diozGo0olybkauNN8b0EGgDwXcUtGLy6rOeqooGfLGiI92S6Jg4wGTTNVhAW7eRa9KKOipULNltm2uH1TYQpZ' +
    '1UAZiwgtA6pFmLa7s4wyIsFaGyVkqx/paGIOqyZ1Tc1sNPC0rOnQiseUChYbKKeaFjJQlnVQLGsaFph5SBr19AqOKqWSJA3GR4bjQ5HocIRY' +
    'anADpxU3L9QFFaayutieFktla4YIPaGloZXJp7BPe5QLTgyDi66RV6MmsZWgYZLGZaiZJD0GzOXseWQNzKFKHKY05lEvWZgHeAqoZuMMYIlr' +
    'WDQn/GAeaXpm1TOOfz91lYNFynjZtPTCg2rQ6bKqZVMuF06q6qagUlmsajdSOYxHx/ZjD7hQUjXk0q643sHExyuL7xP9X97cBoA8beR117NI' +
    'C79Eai5vmeH80NupicetLd0ttkEgAJpsrRr2KYi9u87kS7SUaLlFy88+1i7Zsk7a3k779+rNPZ+cJNr7HjA/P/xOGQAC5xFTkw+TpJyndcan' +
    'XR+vt4YXOlI6C2qNl2Mn9CsBmeNvG+VvXzPPf4e/oCF/BQR/3fxl69iW38s3B8lT8jv7LDEhAV91Vd/q4P1s0/r3Lj6ukMzrTdF63n8+5499' +
    't7x5uERXFgn4QRBnj3zLSb1LkmyLtmoOA1w+L5C5aK7l+Ml4YkYC1MCjR+D8sQsAW+5oGCCtrXJxfrss3jUBAQEBAQEBAQEBAQEBgbOKRvvk' +
    '3v2Zo/bJA1dpKVJ6LuHdZ2T7fntdvF6aHGsB1/7eX+Jvqdupv+s5Hn/begV/BX/r+bvdw+uxc57T4q+zTy5VeTfVzXgNDuSxQKN14ODzsnnF' +
    'qS+B460DnTf5+Rc43+sA49NOiNeL0DIK+Pd17JTWgeQ1vt91Wv8QEnN0GNj335uvk56XkfMudl7mo/aSS0ECfU7pcxqaqB07rvTWZcwootke' +
    'uk5lIdARAB2vqnoBW+7zOR0GKANlafcGZYZnxOv/1fyxc2P2Huwoh+uzdXrpluA+/z308tThkSRJHB//nJclekMr6Ilg68znKDkt+YJy4yuq' +
    'DK/tEXMXVr2m3iunNVPyz47rAqrb8KB7cjXDn3L9rbnktP+CM1sy+IrLT3dJ7TeYVtjiaSsAAA==';

const COLLIDE_KERAS =
    'H4sIAJFliWoC/+1bTUwTQRSe3VKtqBETIoUglI0EDVDbErQhHjCANsHoRokxMaasdISVpdt0t1hCGj3Wi3L0ZDx68NB49uDRo4k3Th408ejR' +
    'm87szLQ704IUqkGZL9k83syb/68z8x4ZfTbQ1gkIBsBm+OvLSfQX/o6jbwW6RsZwjehDx86ua8swbzjpVZh3TDurTUS0sWh8PBrXRiIasoJp' +
    'x1iFGZyeiCUujMaSo4nEZPzixHhyIn5RK+lcU8u3i+/CCgD4O4pSFuzsA3ORNrRiZwoWRDVlC5aFal+wDMdJZ40VnKZN2ZZlZiBulpRCieua' +
    'mzfMrHHfK+bmCxB3yl3LQS+zWiEZg1ZX5/QcMtVty1xYE+plFg8s23DHEloJZefhoum4MA8zrALc0VLjLH9/7xdMK5P21W5mcwU37SwZXkfv' +
    'xkciY/dKXgdWcqYFfaYl3wSmnp+6N/fpWRjEkYK+DrxWdgZa0UfQXFxynejS+NPU9JXj7T3tXoFQCLR5VjX8pPDq8OsU81QqVJapfK2ydMXL' +
    'C9P0k7R+0W7u5swMtv4pgLXzOUhkCEgcRKRmLutY3qF6hMoPKm+3auQdLDMw60AkLWMN4hTGz2ST7SogwPG3g/L37GGe/4S/YEv+Skj++vnL' +
    '9rFyUOQbgd6idm9dvzGNOcx29XIX306F6h+7iWQ8T2m8XY7qG2f4/kcCvF2K6kvB/2v92Lklju+YdwvC4w+CTjQr+DTHereieCU6qnMT4uYJ' +
    'bx/lw7W5uzp145oCaAHBDngXH+92ANh2106l4br5NNvsEGj3wBEqbXRv8PZAYTwvTsjfpISEhISEhISEhISEhITE38ZWcXIxPvO7OHnoNPBF' +
    'GyQOGsQ4I4v7fe/m7VicvBq32zN/G8fJ9T6iz4Od8fdLP99viYPNX8anSi9vF6MyXuUfweQu2yVxcqW6b6Z6+HpzVN/olWu0Hdi5Jc7XbuPk' +
    'OM7N4uQqLa/4DBRwlkiVJLD499Yy7BU9GekHbV5KBHSFQNdjmh9E7eN8VSUVhigDA8p7ujOdEUZc3PdrQritVrld6dvenu29IwOSz/wZJ3KP' +
    'cENRlBZz7ZLGfjU8yv/c/VX8v+Hvzv8PQ/L+Ks//+vtrRdh22b88W3d/bczf2CDR9aGd8ffjsOSv5G89f3NDf9b/Eu+voUH+/iryWKI5PzY8' +
    '2pwf+yoq/Vi5D9T7scXhv+vHdpzj601S/c6wXKOd+LHifO3Wjz3i82MDTfixquBTqHv2LcpRnpH7248Vfdfi6M5812/nJYeb8V3VlvHrR6zx' +
    'DXh/+q76rKJ2BrZ+28LwxBsl99JFLCq+VakVXQbcyxV/wUZvNGoF3yj1Lzb02eAhskIB8BbJzQTWfgHdqeeeojMAAA==';

const BARE_STORE_H5 =
    'H4sIAJFliWoC/+2ay07CQBSGZ6Y0NERjSUy4hIQu8bLAxAfACNqFEaMuWEpSEhcCCSbKzi2+gUuXLln6CD6Gj+AbYNs5UzoDFFNZNOn5Nidz' +
    'YWYy/Tnt/O2r3TzbzpVzxMMwSIaYJMwMmB7KZdF+B5FCnED8YKKe+m1FqM/D+Gq/2+tWy+s9UxDzfOs8GgRJI3br5MqLHSgLPX0xud9Td/To' +
    'RUfRZSPmvJRokn5N0G8tK+t/nX7NEuoX9TvXr8iyE13uV1d0a/9z3pvLdpMSNp8vK4/fKfM4rsj6tDRlHVC+19N5/cR9S92HLcgslOhk1929' +
    'Qbff88olSv1fmMEeGtJ+5kKbTSPuk+r1WZWPJlU5H/2V89P2BQ0JUlqfy/B50Bv1h07vgZdFuhXRceTxPnfwv44gCIIgCIIgCIIgScPzLWjo' +
    '4E/BWaCUV4BdFETNbfda8laVZPwaixQMUniBdp0YfjtjzB/AgPE06nb0qSgrmCRqP7hfRuc+bRE1Eod1fjip8YB+eDpZ5Ye/KelBvM/ZlB++' +
    'TpedfXk9SLp1KdJ/vSr3E+9pjoL7KKcRc17h9/+A/k2YL+77BRZKrgwvK4IgCIIgEefdqfJ9iPo8gixn0UfhB1zKbRCiEflZbLEc11epWMuN' +
    'inECdMUCXdl70f3Feev9ALUUrSvZn2Mb09Ex6Eh1ZJLlz/0C6GNwlLAsAAA=';

const ROOT_LAYERS_H5 =
    'H4sIAHkTiWoC/+1bPVATQRTeOy7hSIITZpwhiAMnNI4OkQhoGFTiCJrCEUYt6GKQG5MhJAyJECotY2dpmZLS0tKSkpKS0tLSDi93793tbn4N' +
    'cSYM72Pg8Xbf7S7L+3bfvr18Sa48Hw7cCLAadJ1pLMx4nANOl0Ud69+BVEBWQB6pWO6z6yJQHob2jQFHn4UH375eXa1Zn0twBwINGIxwFZFc' +
    'fbpekxugx0Eeq6JdNv/Qlrn0oblXZKyUzuZqeqmwm8qZ+2YutVPYsn4emNkPmVLR9dtmfjUC/ir7dYiVwb9D7LrlnHZ/qXx6xyza5WMKs58M' +
    'u9zQHXvF0cD9Ral7v/s5vdalxumK3X8Cftet/nW2mX6/bea3mvcL/fi4djS7nSTUX7Pb2Tb30sXUvjV32UK+1d8B7fHj9NnlAw35Hh509Azj' +
    '+c6a851AfOf4Di7GfvhFO/TD9R71i3wva47+zY98R54M23x31g+P8CPGMowxweaDbP4ciI18l9GMJ2fj4j6q2F+eHY4vcxPsJlq3l4yK7cl4' +
    '8WztpcKA4Nx8wp/vrp8qz3dufZXXMVx/NX69sZD/uLN7yOnYzlw0thCNeXpQaP/eZjbtrKewfFizL9Rby1XezHH+McSN23vaKw/y9e7TjAXc' +
    'eXOwVyiUoI/CQd7cwvk6vUbcJBAIBAKBQCAQCATC5cObV2srinVax/PzuibmAeQ8CJ6Py4OiXXLMkRnIX2Ae4liy+37XkSczjjSgPPFAtMuA' +
    'Xolfjnlse38x6QidXO5KQs5nIo8q46Id5tVcXl2wX8wXyvwMQSa+WT6z3f0F5gNRDnPOXaN8kNP9HfBj4xbxg/jh8QP3j6MJ0Q5TtpjaRZ4k' +
    'LrT/Ka7fVaX9Ss6zExoD7/lx4hR225GqeN+J9wL1esR+dMSYhDKDjeps9BPU+6z/UK1eVZ0GdfCQAaU65VjMSiMq90FcpbrrfPVOa3v0v6RB' +
    'vkQgEAgEAoHiSjGujAjnUK1nceTJlHgyR1T6aj7anaO/xugcTefo+jzT7xnRDt/r6nWeSc7v9jrPxOeVhuAbdZ01f1/uD7wHF4l1xqNfc8Qj' +
    '4lF9PioeE+3+dz7qJIr7Hmvox4RO4wYxH6VJ64qsdx9HnEEcYUgj6q981OxCa3v0v9P75Ev/Eo+qPfMjNt14B6r02Xw0fu+cLYpe326/jT+i' +
    '/Zb22wb3P9L9v/devrgvdrvfup+nkN43CMFIuo1bFSaOL8w5d6BFnFoF3vxc6vC894R4Q7ypP++dLYl2+CGWXp335Di1vCj6u+zHhO7iCXkd' +
    '6T6e0KfFSLc/4wnZrz4/Jh/pBn8BZEiq4dg/AAA=';

const SAVE_WEIGHTS_H5 =
    'H4sIANZ5f2oC/+1az28SQRSe2VK6QVppNCm1hhJOjaYI1SakJ4xF92AsUQ/egNrVEhAaQIsne8Sbxx45evTYP8Gjf4LHHj1yq7s77y070+WH' +
    'FRMi70vI8GbezC7D92befrOfjd3Hi6FbIWZD11mARZgXF4DetmxjexFKDmUHyq8a1s87bVGoj8D48TlhR6Hjy+e5nO19ocC9ERhAZ4RZhJF7' +
    'mLfLV2BvQPldk/0OzFrTLJRrR+9bfdutT7s8TY153WXgq8rrMMsCv3V20/rsl15XzNoBW+Xc6RFxY0KX4iPkITF3xjHg+5IzTsVslJqFD2aj' +
    'Wa7XrPpR4wU942nOeEVoD1vVUVYtfTQbhVrpndl06m9YHa/Z7VyMAGHolp75w6nzzF4f3OrhF9e9oLDxfxJxzQbHNYHi2sMXXN+7QdkP+Z6f' +
    '0HUxrosBYZ8EMa4zcL1FJ36OzfLbw1Y/gOz44Z74UTEoLg7XhN0e8Ltx1z1d8FnPPL/fmPD8P3m095R7bkBapyy0rOvXG2+q9eP+GuOuOxa2' +
    'kuntpGcxPbtOnCYQCAQCgUAgEAgEAmHa8OLZ3q6tWaBekV+QdQBjVZRtqI+j313Zrw326aYoUcfJBGQ/VW/5XzDq/KIbk+eFMFtAvVGNpzAo' +
    'gMP0xiXW1xtRf8PS0QfvVcxGzazupIS1Xy41d1IYd1zSI/E+9NvC3oiNx99enPg7y1D1atwHjJjsh0xEG7mI63/mSvsTd3n3c03eT1QeE/yB' +
    '5/A4cRxOULkmnwPC9uxjR52uy/F1qIuzFZ2tfIL2eesfsts1TQyow4ozx7MJ4aGeuLanIO/R3HUxe2e4P/LvfJ24RCAQCAQCgfJKOa8UGRU+' +
    'rwYmlkceQR4ZUe6gM2Xz4f/+TyQpZ72jnreNND1v0/P25ffDzjZlP/W91r99Pwz1IVXPHUenirAROlUhLStVlt3XB/x1qm8QNz9S48VN9z7F' +
    'DcXNZZ3qlyI//GudqpPE/YD58pgwbj4h61QBZV1R7avnFycJmTGI6dKpzh8M90f+fdkiLv1JnqpNjEfdhP8ONF156m98rAgQ+DUAAA==';

const CHUNKED_NAMES_H5 =
    'H4sIAEx6f2oC/+3dS28TVxjG8XMcSC2UtEZUwu2mWXZF/V5sj6kqgUpKWiGSAgt2wYALEblUcdSIVbdUbPoN2FVZsuQjsGTJsnyDLLOjtmcm' +
    'xC6FiF70pzkvQsdzYWbiOXMe+0Q/8cvChW9mT3x6IgyrWg3HQi0crJdF3fg+ji2X228UbSzaB0W7UynXHxttqxfra8Xx56by5cfF+mtX5ueH' +
    'e7+cqPI8v07nbTWkOoq1MH9+adheL5bL/vS0Mr7f2sbt3urydm/lzt2t/oF+ee4dz3uy6K+T/XqmOGIc9MiPB39vdm/d663fDp/EOPoXtf1z' +
    'V8eejxMHOnEcHWeheP3h6Dj3epvd/vJPvc3+ysb6YP3bjjd94HiVNzxv5Yp6PR7qeXus+X47qesd6edtt+hoC0X75GIs+l8c62flc7LbzLfX' +
    'snK/qdf2x51v43hwFHX18uKFOHqq8no2Nb7bXrFcn0736E31V+/7ro+/7xe/XrwUQzHATI5Tg9rqrfc3Nn9Y3dh+NcbsjzuD0jPSPNN4dd4n' +
    'H6X3PlWqVKlSpUqVKlWqVKlSpaJVOW8zOa8yE/Ye5vMBs6Ea6mG1e7+3ubzeXev1R9/2T8UQHg23x3zG4EVxvLK9ubpx697y7d6PW3e3V/o9' +
    '1KtGo8G+PGFfnrIvz9iX5+zLa7Ivr8W+vDb78jL25XXQlyfs1BB2agg7NYSdGsJODWGnhrBTQ9ipIezUEHZqKDs1lJ0ayk4NZaeGslND2amh' +
    '7NRQdmooOzWUnRrGTg1jp4axU8PYqWHs1DB2ahg7NYydGsZODWOnhrNTw9mp4ezUcHZqODs1nJ0azk4NZ6eGs1PD2anRZKdGk50aTXZqNNmp' +
    '0WSnRpOdGk12ajTZqdFkp0aTnRotdmq02KnRYqdGi50aLXZqtNip0WKnRoudGi12arTYqdFmp0abnRptdmq02anRZqdGm50abXZqtNmp0Wan' +
    'RpudGhk7NTJ2amTs1MjYqZGxUyNjp0bGTo2MnRoZOzUydmp02KnRYadGh50aHXZqdNip0WGnRoedGh12anTYqdFBp4awbbiwbbiwbbiwbbiw' +
    'bbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiw' +
    'bbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiw' +
    'bbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiw' +
    'bbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiwbbiybbiybbiybbiybbiybbiybbiybbiybbiybbiybbiybbiybbiy' +
    'bbiybbiybbiybbiybbiybbiybbiybbiybbiybbiybbiybbiqh5mw9zAMKobZUA31sNq939tcXu+u9foyXH8qhvBouD3G4WJ4EcJYy/752LHD' +
    'xuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXK' +
    'xuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXK' +
    'xuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXKxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXG' +
    'xuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXGxuXG/o/HjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3D' +
    'jW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3D' +
    'jW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3D' +
    'jW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DjW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3D' +
    'nW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3DnW3D' +
    'nW3DnW3DnW3DnW3DnW3DnW3DnW3D3Tvh2pX5+RBieDlRoagHWRy11ZDqKNbC/PmlYbtXLO8U7bNO3i/i6E8I9WL9yVDL9/su375n8Z3Oe/Xy' +
    '4oUYKvv97vkHoThfXvVG/irTOHZdN6bH95ubz1+duxiP9P27XizXyvfPx9+Pmyvd/tnGq/dt4T3/uct+ONlPZsLvRf+YHfStetjurdy5u7W8' +
    '3l3r9YfrTw12+224PcaxflS25PG80Wh8Ud7Ht43rz79M43oa1/88LjSyf3dcyMf1uN/vsonxereZv6plMd2kQxR8PNq/r0v/0M8bw/H8mLFc' +
    'zj95lON1pdivbKcG24dbTs59Fo7lnwjC6Wo4/XOx/figJw63VyqVmI+H+fGm4txXrx8hH6Du/+Tz9PRsem5SpUqVKlWqVKkOU2/7vvz0Uvq+' +
    'nL4v/3ketHb5v/m8Tf+eR/89R5y4b9Qq5y0n563/z/OWg/tz6HnL+lIah49yTc53XNfx/v53f+901Op9Gbffv/nDz9/L+cPqYnpu3qX+AEB1' +
    'lHZgUQEA';

const WEIGHTS_ONLY_H5 =
    'H4sIADLJf2oC/+1cTUwTQRSe3VLYEI3VmPAT1NWEAIYIimIjQUAoNkCgUQ+9QQOLNOmf/THViyZe6s1jjz1y8MCxR44cOXrs0WMP3rHbfa/t' +
    'TLft9sfKz/su07f7OtO++XbeN28K390rq9f7h/uZDkVhPczBKnEGUDZ5G+/vQCtBm4L2UMbrUvHeIFy/Cf2Lfu/euFy695kAHCdnN1qFEa4i' +
    '3K4lj956wR6H9kTm/T76ojG9Dfg+afqrcCTuD/o/a1GBp9MWx5WYjeOvA/g73sfz3+Avq8lfAvG3kr+4jqXsIt8MeDo07tvNrRWdw7iqpwb4' +
    'cY7APh0yWuR5ZJn3S4OddfGfX7Xxfm6wD+yXa/4wb4nf7xpbhO9vZ7cLUQn5gppuD0lS8R2OUmwULk769VRfOXavl7c2JLwh+OnYT4R24/5w' +
    'yBfYDob3tIAs8Ghf88UTUS0GH49B10wL7Rbco4W8bnZ9j+E09UIbCL/3x2NlG/uPBrdjkWg4gvHw3qBnmkAgEAgEAoFAIBAIhGZRq04u1mca' +
    '1cmVO0Y7SCG9khDrjFjnzg/xfv5QJBHfLlbJi3ZM+5DQQnG/L2Dc39NCMY2V61DjLfI3MmzYP0as8ddxH3hMU0n8ZeX659EI74fnPKW6c5vj' +
    'Yp0ceZ51Iq8N5MBmczw/3cO8n8h3fB6yD4T+wGajly2PmZ+XeeH77rDKdYDOywjW1gF83rKqyDcDnT0vk0rjee7y4yTBTqs0R/WA+V+MV6vn' +
    'ZbqF52VyHb0hrquN9IZznPQGrTPldQb5pI6a6w38XQnycrHDefLrBOVJQvt5MjfWjTwpl/R5boIfR3kI+8ZJ/nMlR3m/DNjHY1c7T4pxaDVP' +
    '9lXkSVudPCnOT6M8uTNFeZLWmep9uXuS9xPrRu3uy2vx9wTG/f3IGn8PZoi/xN9q/ipT3agrlfeTmUk+/4k8JjSnl4+emunl2uuAZ5affwLt' +
    '94p8mOH98NzksaCfFzu0DhxO8/2egp1/QnNkRS+L8eqEXu6B90sVDhKcCEiyVNLU6GtuDxbfelO9B9dUNqCwgS9w314YX78vy0aHCjDQJqmz' +
    'PPMQyQs1P7gvRJ47ntX3x3U4/Zy4zec7kYcGTyRJ4vjWPu8OneYZMXXO41Oj/iuc0zWs/76kfQHpgep9gTr3b/cFNeu/C83pWccS6Vnib7We' +
    'zc13V88m5/h+M2Afz9McWdGzYrxa1bO9FXrWbkHPon6QBT0ht60r8kAt9ULpWVG/5has6VfvK+JyM/pV7hjPDpbNFVzqnMbFXLeKf1/dKO/n' +
    '3aRbKe9X69Zfrv+jW51rzenWn+ukW4m/1bo17e6ubp1e5fv1gp100xxZ0a1ivDrx+75eU/3A++v/0UR/7VBYSS80qHOt8woXkbkwMRe1aXrN' +
    'mjb9s0F8ra9NRW61qkV7Ns05lj7X8Qjf+vbiLxbdBWIITgAA';

const PLAIN_H5 =
    'H4sIALj3fmoC/+2YzUrDQBSF7yRNCVExhS5ScRFExAfovhFb7UKsqAuX7WIQoT/SRHDpUt+kj9JlH8Olb1CTzJ2SSTcign/ng3B6Z+7MhHBu' +
    'Qu9Lt32y5e14lOG6VCGfiiyZfmjGer7PKlifWWeWHrfzuYDHfd4/tM3115edTpa9LKHPiapKXQL/kW7n6CLTG461n+aWmTeSg/hhKkdynMRF' +
    'X0afPLfGfi37epN3FFSleurK5C4ZyjRuCJGv8Fdnu0Z9eAUTi/wSRn3o82ZcH3PnY/XhN1AfqI/1+nh1zLxEju7ldJCkNUJfUR9X57125mDt' +
    'uyfb/B6UfQx+FqfHvTNB/MIqv6dSYjmOJ9NwOLk11y228ewAAAAAAAAAAIDfgiBH/ecXOj5UaqkBbt9QhXU9DvKltbDFPaCImhvUXHKik45m' +
    '85alNnS5M2ULClVGv3RHj9/6PMr9rFUjDQAAAPizvLX4R6TEZfVZ66wB6y5ryLrHus96EL0D+MVM8WAgAAA=';

const inflate = (base64: string): Uint8Array => new Uint8Array(gunzipSync(Buffer.from(base64, 'base64')));

/** Functional model whose layer names and store names are in opposite order. */
export const swapKerasArchive = (): Uint8Array => inflate(SWAP_KERAS);
/** Compiled Sequential CNN with a renamed head layer. */
export const cnnKerasArchive = (): Uint8Array => inflate(CNN_KERAS);
/** Functional model wrapping a Sequential sub-model. */
export const nestedKerasArchive = (): Uint8Array => inflate(NESTED_KERAS);
/** Functional model that owns a variable itself, stored at the store root. */
export const modelOwnedWeightArchive = (): Uint8Array => inflate(OWNED_KERAS);
/** Sequential with a Bidirectional LSTM. */
export const rnnKerasArchive = (): Uint8Array => inflate(RNN_KERAS);
/** The model-owned-variable model saved in the legacy HDF5 format. */
export const modelOwnedWeightHdf5 = (): Uint8Array => inflate(OWNED_LEGACY_H5);
/** Keras model saved in the legacy HDF5 format. */
export const legacyKerasHdf5 = (): Uint8Array => inflate(LEGACY_H5);
/** Subclassed model whose store addresses children by attribute name. */
export const subclassedKerasArchive = (): Uint8Array => inflate(SUBCLASSED_KERAS);
/** Model with a non-ASCII layer class name. */
export const unicodeClassArchive = (): Uint8Array => inflate(UNICODE_KERAS);
/** Custom layer owning its variables whose config omits `name`. */
export const unnamedLayerArchive = (): Uint8Array => inflate(NONAME_KERAS);
/** Subclassed model whose two layers share a store leaf name. */
export const collidingStoreNamesArchive = (): Uint8Array => inflate(COLLIDE_KERAS);
/** A Keras 3 weight store saved on its own, with a model-owned variable. */
export const bareWeightStoreHdf5 = (): Uint8Array => inflate(BARE_STORE_H5);
/** `save_weights` checkpoint whose layer is literally named `layers`. */
export const rootLayersNamedHdf5 = (): Uint8Array => inflate(ROOT_LAYERS_H5);
/** Keras 2 `model.save_weights(...)`: layer groups at the root of the file. */
export const kerasSavedWeightsHdf5 = (): Uint8Array => inflate(SAVE_WEIGHTS_H5);
/** Keras 2 model whose `layer_names` attribute was split into chunks. */
export const chunkedLayerNamesHdf5 = (): Uint8Array => inflate(CHUNKED_NAMES_H5);
/** A Keras 3 weight store outside its `.keras` archive. */
export const kerasWeightStore = (): Uint8Array => inflate(WEIGHTS_ONLY_H5);
/** An HDF5 file that is not a Keras model. */
export const plainHdf5 = (): Uint8Array => inflate(PLAIN_H5);
