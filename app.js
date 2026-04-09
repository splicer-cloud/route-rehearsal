const form = document.querySelector("#route-form");
const result = document.querySelector("#result");

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const start = formData.get("start")?.toString().trim();
  const destination = formData.get("destination")?.toString().trim();

  result.innerHTML = `
    <h2>Starter preview</h2>
    <p><strong>From:</strong> ${start}</p>
    <p><strong>To:</strong> ${destination}</p>
    <p>
      Next we will replace this placeholder with a real route, a map, and a few
      calm step-by-step moments for the drive.
    </p>
  `;
});
