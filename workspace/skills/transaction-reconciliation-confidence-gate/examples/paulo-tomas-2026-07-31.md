# Paulo Tomas miss pattern, 2026-07-31

The first pass found only later Paulo invoices because the earlier files were generic inbox filenames with null extraction:

- `Invoice 27-04-2026.pdf`
- `Invoice 22-05-2026.pdf`
- `Invoice 26-05-2026.pdf`
- `Invoice 01-06-2026.pdf`
- `GP Invoice 17-06-2026.pdf`

They were `processing`/generic rows, not supplier-name hits. The correct sweep was to list invoice-like inbox files over the full period and match them against Wise EUR payments by date and USD amount. Resulting draft bill amounts created in EUR: 221.67, 224.18, 189.80, 223.20, 226.00.