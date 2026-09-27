import re

file_path = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/public/index.html"
with open(file_path, "r") as f:
    content = f.read()

# Update favicon link
if '<!-- <link rel="icon" href="%PUBLIC_URL%/favicon.ico" /> -->' in content:
    content = content.replace(
        '<!-- <link rel="icon" href="%PUBLIC_URL%/favicon.ico" /> -->',
        '<link rel="icon" type="image/png" href="%PUBLIC_URL%/favicon.png" />'
    )
elif '<link rel="icon" href="%PUBLIC_URL%/favicon.ico" />' in content:
    content = content.replace(
        '<link rel="icon" href="%PUBLIC_URL%/favicon.ico" />',
        '<link rel="icon" type="image/png" href="%PUBLIC_URL%/favicon.png" />'
    )
else:
    # If not found, insert after <meta charset="utf-8" />
    content = content.replace(
        '<meta charset="utf-8" />',
        '<meta charset="utf-8" />\n  <link rel="icon" type="image/png" href="%PUBLIC_URL%/favicon.png" />'
    )

content = content.replace(
    '<link rel="apple-touch-icon" href="" />',
    '<link rel="apple-touch-icon" href="%PUBLIC_URL%/favicon.png" />'
)

with open(file_path, "w") as f:
    f.write(content)

print("Done favicon update")
