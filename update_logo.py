import re

file_path = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/src/pages/NewThankyouPage.js"
with open(file_path, "r") as f:
    content = f.read()

# Update logo
content = content.replace(
    'import newlogo from "../assets/logos/black_logo.png";',
    'import newlogo from "../assets/logos/beewell_logo_logo.png";'
)

with open(file_path, "w") as f:
    f.write(content)

print("Done logo")
