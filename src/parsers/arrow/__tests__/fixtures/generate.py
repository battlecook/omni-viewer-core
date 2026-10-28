"""Regenerate small interoperability fixtures with `pip install pyarrow`.

All data is synthetic. Base64 keeps the repository's binary fixture convention.
"""
import base64
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather

table = pa.table({
    'id': pa.array([9007199254740993, None, -9007199254740993], pa.int64()),
    'name': pa.array(['alpha', 'beta', None]).dictionary_encode(),
    'amount': pa.array([Decimal('123.45'), Decimal('-0.01'), None], pa.decimal128(20, 2)),
    'list': pa.array([[1, 2], [], None], pa.list_(pa.int32())),
    'struct': pa.array([{'x': 7}, None, {'x': None}], pa.struct([('x', pa.int32())]))
}).replace_schema_metadata({'source': 'pyarrow'})

for codec in ['uncompressed', 'lz4', 'zstd']:
    sink = pa.BufferOutputStream()
    feather.write_feather(table, sink, compression=codec, chunksize=2)
    Path(__file__).with_name(f'{codec}.feather.b64').write_text(
        base64.b64encode(sink.getvalue().to_pybytes()).decode() + '\n'
    )

duplicates = pa.StructArray.from_arrays([pa.array([1, 3], pa.int32()), pa.array([2, 4], pa.int32())], names=['x', 'x'])
sink = pa.BufferOutputStream()
feather.write_feather(pa.table({'value': duplicates}), sink, compression='uncompressed')
Path(__file__).with_name('duplicate-fields.feather.b64').write_text(
    base64.b64encode(sink.getvalue().to_pybytes()).decode() + '\n'
)
