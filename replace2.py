import re

file_path = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/src/pages/NewThankyouPage.js"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace(
    "To proceed with your order, please complete your medical consultation forms in your member portal.",
    "To proceed with your order, please complete your intake form."
)
content = content.replace(
    "Look for member portal credentials in your email inbox",
    "Look for your order confirmation in your email inbox"
)
content = content.replace(
    "Use your credentials to access your member portal",
    "Click the button below to start your intake"
)
content = content.replace(
    "Login to Portal",
    "Start Intake"
)

with open(file_path, "w") as f:
    f.write(content)

print("Done")
