// Shared behaviour: theme switch, code-sample tabs and copy buttons on code blocks.

const themeButtons = document.querySelectorAll(".theme-switch button");

function showTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.value === theme)));
}

showTheme(document.documentElement.dataset.theme ?? "system");

themeButtons.forEach((button) => button.addEventListener("click", () => {
  showTheme(button.value);
  localStorage.setItem("toys.theme", button.value);
}));

document.querySelectorAll("#code-tabs [role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.panel;

    tab.parentElement.querySelectorAll("[role=tab]").forEach((other) => {
      other.setAttribute("aria-selected", String(other === tab));
    });

    document.querySelectorAll(".code-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== target;
    });
  });
});

document.querySelectorAll(".code-block .copy").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.parentElement.querySelector("pre").innerText;
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
});
