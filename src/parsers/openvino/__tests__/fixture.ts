/** Hand-written IR v11 fixture: Parameter → MatMul(Const) → Add(Const) → Relu → Result. */
export const IR_V11_XML = `<?xml version="1.0"?>
<net name="tiny_mlp" version="11">
\t<layers>
\t\t<layer id="0" name="input" type="Parameter" version="opset1">
\t\t\t<data shape="1,4" element_type="f32" />
\t\t\t<rt_info>
\t\t\t\t<attribute name="fused_names" version="0" value="input" />
\t\t\t</rt_info>
\t\t\t<output>
\t\t\t\t<port id="0" precision="FP32" names="input,x">
\t\t\t\t\t<dim>1</dim>
\t\t\t\t\t<dim>4</dim>
\t\t\t\t</port>
\t\t\t</output>
\t\t</layer>
\t\t<layer id="1" name="fc/weights" type="Const" version="opset1">
\t\t\t<data element_type="f32" shape="4,2" offset="0" size="32" />
\t\t\t<output>
\t\t\t\t<port id="0" precision="FP32">
\t\t\t\t\t<dim>4</dim>
\t\t\t\t\t<dim>2</dim>
\t\t\t\t</port>
\t\t\t</output>
\t\t</layer>
\t\t<layer id="2" name="fc" type="MatMul" version="opset1">
\t\t\t<data transpose_a="false" transpose_b="false" />
\t\t\t<input>
\t\t\t\t<port id="0" precision="FP32">
\t\t\t\t\t<dim>1</dim>
\t\t\t\t\t<dim>4</dim>
\t\t\t\t</port>
\t\t\t\t<port id="1" precision="FP32">
\t\t\t\t\t<dim>4</dim>
\t\t\t\t\t<dim>2</dim>
\t\t\t\t</port>
\t\t\t</input>
\t\t\t<output>
\t\t\t\t<port id="2" precision="FP32" names="fc">
\t\t\t\t\t<dim>1</dim>
\t\t\t\t\t<dim>2</dim>
\t\t\t\t\t<rt_info>
\t\t\t\t\t\t<attribute name="layout" version="0" layout="[N,C]" />
\t\t\t\t\t</rt_info>
\t\t\t\t</port>
\t\t\t</output>
\t\t</layer>
\t\t<layer id="3" name="fc/bias" type="Const" version="opset1">
\t\t\t<data element_type="f16" shape="1,2" offset="32" size="4" />
\t\t\t<rt_info>
\t\t\t\t<attribute name="decompression" version="0" />
\t\t\t</rt_info>
\t\t\t<output>
\t\t\t\t<port id="0" precision="FP16">
\t\t\t\t\t<dim>1</dim>
\t\t\t\t\t<dim>2</dim>
\t\t\t\t</port>
\t\t\t</output>
\t\t</layer>
\t\t<layer id="4" name="add" type="Add" version="opset1">
\t\t\t<data auto_broadcast="numpy" />
\t\t\t<input>
\t\t\t\t<port id="0" precision="FP32"><dim>1</dim><dim>2</dim></port>
\t\t\t\t<port id="1" precision="FP16"><dim>1</dim><dim>2</dim></port>
\t\t\t</input>
\t\t\t<output>
\t\t\t\t<port id="2" precision="FP32" names="add"><dim>1</dim><dim>2</dim></port>
\t\t\t</output>
\t\t</layer>
\t\t<layer id="5" name="relu" type="ReLU" version="opset1">
\t\t\t<input><port id="0" precision="FP32"><dim>1</dim><dim>2</dim></port></input>
\t\t\t<output><port id="1" precision="FP32" names="relu"><dim>1</dim><dim>2</dim></port></output>
\t\t</layer>
\t\t<layer id="6" name="output" type="Result" version="opset1" output_names="logits,relu">
\t\t\t<input><port id="0" precision="FP32"><dim>1</dim><dim>2</dim></port></input>
\t\t</layer>
\t</layers>
\t<edges>
\t\t<edge from-layer="0" from-port="0" to-layer="2" to-port="0" />
\t\t<edge from-layer="1" from-port="0" to-layer="2" to-port="1" />
\t\t<edge from-layer="2" from-port="2" to-layer="4" to-port="0" />
\t\t<edge from-layer="3" from-port="0" to-layer="4" to-port="1" />
\t\t<edge from-layer="4" from-port="2" to-layer="5" to-port="0" />
\t\t<edge from-layer="5" from-port="1" to-layer="6" to-port="0" />
\t</edges>
\t<rt_info>
\t\t<MO_version value="2024.6.0-17404-4c0f47d2335-releases/2024/6" />
\t\t<Runtime_version value="2024.6.0-17404-4c0f47d2335-releases/2024/6" />
\t\t<conversion_parameters>
\t\t\t<framework value="pytorch" />
\t\t\t<is_python_object value="True" />
\t\t</conversion_parameters>
\t\t<optimization>
\t\t\t<description>quantized &amp; pruned</description>
\t\t</optimization>
\t</rt_info>
</net>
`;

/** 8 f32 weights followed by 2 f16 biases, little-endian, matching IR_V11_XML. */
export function irV11Weights(): Uint8Array {
    const out = new Uint8Array(36);
    const view = new DataView(out.buffer);
    [0.5, -1.25, 2, 0, 3.5, -0.75, 1, 8].forEach((value, index) => view.setFloat32(index * 4, value, true));
    view.setUint16(32, 0x3c00, true); // 1.0
    view.setUint16(34, 0xc000, true); // -2.0
    return out;
}

/** Legacy IR v7 layout with <blobs> and layer-level precision. */
export const IR_V7_XML = `<net name="legacy" version="7" batch="1">
  <layers>
    <layer id="0" name="data" precision="FP32" type="Input">
      <output><port id="0"><dim>1</dim><dim>3</dim></port></output>
    </layer>
    <layer id="1" name="fc" precision="FP32" type="FullyConnected">
      <data out-size="2"/>
      <input><port id="0"><dim>1</dim><dim>3</dim></port></input>
      <output><port id="1"><dim>1</dim><dim>2</dim></port></output>
      <blobs>
        <weights offset="0" size="24"/>
        <biases offset="24" size="8"/>
      </blobs>
    </layer>
  </layers>
  <edges>
    <edge from-layer="0" from-port="0" to-layer="1" to-port="0"/>
  </edges>
  <meta_data>
    <MO_version value="2019.3.0"/>
    <cli_parameters>
      <input_model value="model.caffemodel"/>
    </cli_parameters>
  </meta_data>
</net>
`;

/** IR v11 with a Loop whose <body> holds its own layers, edges, and a Const
 *  (offset 4) that shares the .bin with the top-level Const (offset 0), plus
 *  a `\,`-escaped tensor name, an <info name> rt_info entry, and scanner
 *  corner cases (DOCTYPE, comments inside <layers>, CDATA in metadata). */
export const IR_LOOP_XML = `<?xml version="1.0"?>
<!DOCTYPE net [ <!ENTITY unused "x"> ]>
<net name="looped" version="11">
  <layers>
    <!-- a comment between layers -->
    <layer id="0" name="x" type="Parameter" version="opset1">
      <data shape="1" element_type="f32"/>
      <output><port id="0" precision="FP32" names="x\\,0,alias"><dim>1</dim></port></output>
    </layer>
    <layer id="1" name="k" type="Const" version="opset1">
      <data element_type="f32" shape="1" offset="0" size="4"/>
      <output><port id="0" precision="FP32"><dim>1</dim></port></output>
    </layer>
    <layer id="2" name="loop" type="Loop" version="opset5">
      <data/>
      <input>
        <port id="0" precision="I64"><dim>1</dim></port>
        <port id="1" precision="BOOL"><dim>1</dim><rt_info><attribute name="fused_names" version="0" value="loop_cond"/></rt_info></port>
        <port id="2" precision="FP32"><dim>1</dim></port>
      </input>
      <output><port id="3" precision="FP32" names="y"><dim>1</dim></port></output>
      <port_map>
        <input external_port_id="2" internal_layer_id="0"/>
        <output external_port_id="3" internal_layer_id="3"/>
      </port_map>
      <back_edges><edge from-layer="3" to-layer="0"/></back_edges>
      <body>
        <layers>
          <layer id="0" name="body_in" type="Parameter" version="opset1">
            <data shape="1" element_type="f32"/>
            <output><port id="0" precision="FP32"><dim>1</dim></port></output>
          </layer>
          <layer id="1" name="body_k" type="Const" version="opset1">
            <data element_type="f32" shape="1" offset="4" size="4"/>
            <output><port id="0" precision="FP32"><dim>1</dim></port></output>
          </layer>
          <layer id="2" name="body_add" type="Add" version="opset1">
            <input>
              <port id="0" precision="FP32"><dim>1</dim></port>
              <port id="1" precision="FP32"><dim>1</dim></port>
            </input>
            <output><port id="2" precision="FP32" names="body_out"><dim>1</dim></port></output>
          </layer>
          <layer id="3" name="body_res" type="Result" version="opset1">
            <input><port id="0" precision="FP32"><dim>1</dim></port></input>
          </layer>
        </layers>
        <edges>
          <edge from-layer="0" from-port="0" to-layer="2" to-port="0"/>
          <edge from-layer="1" from-port="0" to-layer="2" to-port="1"/>
          <edge from-layer="2" from-port="2" to-layer="3" to-port="0"/>
        </edges>
      </body>
      <rt_info>
        <attribute name="layout" version="0" layout="[N]"/>
      </rt_info>
    </layer>
    <layer id="3" name="res" type="Result" version="opset1">
      <input><port id="0" precision="FP32"><dim>1</dim></port></input>
    </layer>
  </layers>
  <edges>
    <edge from-layer="0" from-port="0" to-layer="2" to-port="2"/>
    <edge from-layer="2" from-port="3" to-layer="3" to-port="0"/>
  </edges>
  <rt_info>
    <info name="my key" value="my value"/>
    <notes><![CDATA[a <b> & c]]></notes>
  </rt_info>
</net>
`;

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
