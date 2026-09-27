import re

file_path = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/src/pages/NewThankyouPage.js"
with open(file_path, "r") as f:
    content = f.read()

old_click = 'onClick={() => (window.location.href = "/joinbeewell_intake.html")}'
new_click = """onClick={() => {
                  const params = new URLSearchParams({
                    order_id: orderId || '',
                    unique_id: orderId || '',
                    email: email || '',
                    'fullName[0]': firstName || '',
                    'fullName[1]': lastName || '',
                    phoneNumber: phoneNumber || '',
                    usState: (stateName && stateCode) ? `${stateName} (${stateCode})` : (stateName || '')
                  });
                  window.location.href = `/joinbeewell_intake.html?${params.toString()}`;
                }}"""

if old_click in content:
    content = content.replace(old_click, new_click)
    with open(file_path, "w") as f:
        f.write(content)
    print("Done")
else:
    print("Could not find the onClick string to replace.")

