import re

file_path = "/Users/amitdasadiya/Documents/coreagerx-projects-no-deps/joinbeewell_checkoutt/src/pages/NewThankyouPage.js"
with open(file_path, "r") as f:
    content = f.read()

# Replace button text and onClick
content = content.replace('onClick={() => (window.location.href = memberPortalUrl)}', 'onClick={() => (window.location.href = "/joinbeewell_intake.html")}')
content = content.replace('<span className="text-white">Access Member Portal</span>', '<span className="text-white">Intake</span>')
content = content.replace('<span>Access Member Portal</span>', '<span>Intake</span>')

# Replace Member Portal Access block
old_member_portal = """              <h3 className="font-semibold text-gray-800 text-sm sm:text-base">
                Member Portal Access
              </h3>
            </div>
            <div className="text-center space-y-2">
              <p className="text-sm text-gray-600">
                Your member portal credentials have been sent to:{" "}
                <span className="font-semibold text-gray-800">{email}</span>
              </p>
              <p className="text-xs text-gray-500">
                If you don't see the email, please check your spam folder or
                contact our support team.
              </p>
            </div>"""

new_intake = """              <h3 className="font-semibold text-gray-800 text-sm sm:text-base">
                Intake
              </h3>
            </div>
            <div className="text-center space-y-2">
              <p className="text-sm text-gray-600">
                Please complete your intake form to proceed.
              </p>
            </div>"""

content = content.replace(old_member_portal, new_intake)

with open(file_path, "w") as f:
    f.write(content)

print("Done")
