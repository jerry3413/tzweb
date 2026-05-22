"""将 .xlsx 文件的第一张表输出为 CSV 文本到 stdout。"""
import sys
import csv
import io
from openpyxl import load_workbook

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python3 parse-xlsx.py <xlsx-file-path>\n")
        sys.exit(1)

    path = sys.argv[1]
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active

    out = io.StringIO()
    writer = csv.writer(out)
    for row in ws.iter_rows(values_only=True):
        writer.writerow([str(c) if c is not None else '' for c in row])

    print(out.getvalue())

if __name__ == '__main__':
    main()
