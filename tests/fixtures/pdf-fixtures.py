"""Trusted in-memory test vectors only. No user agreements or output files."""
import base64
import io
import json
import pikepdf

N, D, A, S = pikepdf.Name, pikepdf.Dictionary, pikepdf.Array, pikepdf.String
results = {}


def vector(name, edit=lambda p: None, **save):
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(612, 792))
        # These words are harmless visible content, not executable dictionaries.
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 30 40 Td (JavaScript Launch PRIVATE text) Tj ET")
        page.Resources = D(Font=D(F1=D(Type=N.Font, Subtype=N.Type1, BaseFont=N.Helvetica)))
        edit(pdf)
        out = io.BytesIO()
        pdf.save(out, static_id=True, **save)
        results[name] = base64.b64encode(out.getvalue()).decode("ascii")


vector("ordinary")
vector("object_streams", object_stream_mode=pikepdf.ObjectStreamMode.generate)
vector("linearized", linearize=True)
vector("rotated", lambda p: p.pages[0].obj.update(D(Rotate=-90, CropBox=A([10, 20, 600, 780]))))
vector("scaled", lambda p: p.pages[0].obj.update(D(UserUnit=2)))
vector("bad_box", lambda p: p.pages[0].obj.update(D(MediaBox=A([0, 0, 0, 792]))))
vector("string_box", lambda p: p.pages[0].obj.update(D(MediaBox=A([0, 0, S("612"), 792]))))
vector("bad_rotation", lambda p: p.pages[0].obj.update(D(Rotate=45)))
vector("oversize_geometry", lambda p: p.pages[0].obj.update(D(UserUnit=100)))
vector("zero_unit", lambda p: p.pages[0].obj.update(D(UserUnit=0)))
vector("javascript", lambda p: p.Root.update(D(OpenAction=D(S=N.JavaScript, JS=S("PRIVATE malicious script")))))
vector("nested_javascript", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 10, 10]), A=D(S=N.JavaScript, JS=S("PRIVATE"))))]))))
vector("hex_name_javascript", lambda p: p.Root.update(D(OpenAction=pikepdf.Object.parse(b"<< /S /J#61vaScript /JS (private) >>"))))
vector("launch", lambda p: p.Root.update(D(OpenAction=D(S=N.Launch, F=S("/PRIVATE/local/file")))))
vector("form_submit", lambda p: p.pages[0].obj.update(D(AA=D(O=D(S=N.SubmitForm, F=S("https://example.test/private"))))))
vector("xfa", lambda p: p.Root.update(D(AcroForm=D(XFA=p.make_stream(b"<PRIVATE/>")))))
vector("embedded", lambda p: p.attachments.__setitem__("private.txt", b"PRIVATE attached bytes"))
vector("multimedia", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.RichMedia, Rect=A([0, 0, 20, 20])))]))))
vector("external_stream", lambda p: p.pages[0].Contents.stream_dict.update(D(F=S("/PRIVATE/local/file"))))
vector("existing_signature", lambda p: p.Root.update(D(PRIVATE=p.make_indirect(D(Type=N.Sig, ByteRange=A([0, 1, 2, 3]), Contents=S("private"))))))
vector("https_link", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 20, 20]), A=D(S=N.URI, URI=S("https://example.test/terms"))))]))))
vector("javascript_link", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 20, 20]), A=D(S=N.URI, URI=S("javascript:private()"))))]))))
vector("encoded_control_link", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 20, 20]), A=D(S=N.URI, URI=S("mailto:user%0ABcc:private@example.test"))))]))))
vector("credential_link", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 20, 20]), A=D(S=N.URI, URI=S("https://@example.test"))))]))))
vector("chained_link", lambda p: p.pages[0].obj.update(D(Annots=A([p.make_indirect(D(Type=N.Annot, Subtype=N.Link, Rect=A([0, 0, 20, 20]), A=D(S=N.URI, URI=S("https://example.test"), Next=D(S=N.URI, URI=S("https://example.test/next")) )))]))))
vector("encrypted", encryption=pikepdf.Encryption(owner="private-owner", user="private-password", R=6))
vector("owner_encrypted", encryption=pikepdf.Encryption(owner="private-owner", user="", R=6))
vector("internal_opening", lambda p: p.Root.update(D(OpenAction=A([p.pages[0].obj, N.Fit]))))
vector("automatic_link", lambda p: p.Root.update(D(OpenAction=D(S=N.URI, URI=S("https://example.test")))))


def form(pdf):
    field = pdf.make_indirect(D(Type=N.Annot, Subtype=N.Widget, FT=N.Tx, T=S("Field1"), V=S("PRIVATE value"), Rect=A([20, 20, 200, 50]), P=pdf.pages[0].obj))
    pdf.Root.AcroForm = D(Fields=A([field]))
    pdf.pages[0].Annots = A([field])


def cycle(pdf):
    node = pdf.make_indirect(D())
    node.PRIVATE = node
    node.S = node
    pdf.Root.PRIVATE = node


def page_limit(pdf):
    for _ in range(1000):
        pdf.add_blank_page()


def work_limit(pdf):
    pdf.Root.PRIVATE = A([0] * 50001)


def depth_limit(pdf):
    node = D()
    for _ in range(70):
        node = D(PRIVATE=node)
    pdf.Root.PRIVATE = node


def claimed_provenance(pdf):
    stream = pdf.make_stream(b"PRIVATE unverified bytes, not an authenticated C2PA manifest")
    stream.Type, stream.Subtype = N.EmbeddedFile, N("/application/c2pa")
    spec = pdf.make_indirect(D(Type=N.Filespec, F=S("manifest.c2pa"), EF=D(F=stream)))
    pdf.Root.Names = D(EmbeddedFiles=D(Names=A([S("manifest.c2pa"), spec])))


vector("interactive", form)
vector("cycle", cycle)
vector("page_limit", page_limit)
vector("work_limit", work_limit)
vector("depth_limit", depth_limit)
vector("claimed_provenance", claimed_provenance)
raw = base64.b64decode(results["ordinary"])
assert b"/MediaBox" in raw
results["missing_box"] = base64.b64encode(raw.replace(b"/MediaBox", b"/OtherBox")).decode("ascii")
results["truncated"] = base64.b64encode(raw[:len(raw) // 2]).decode("ascii")
sysout = json.dumps(results, separators=(",", ":"))
print(sysout)
