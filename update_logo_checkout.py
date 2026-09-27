import re
import os

directory = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/src"
for root, _, files in os.walk(directory):
    for file in files:
        if file.endswith(".js") or file.endswith(".jsx"):
            filepath = os.path.join(root, file)
            with open(filepath, "r") as f:
                content = f.read()
            if 'black_logo.png' in content:
                content = content.replace(
                    'black_logo.png',
                    'beewell_logo_logo-removebg-preview.png'
                )
                with open(filepath, "w") as f:
                    f.write(content)
                print(f"Updated {filepath}")

