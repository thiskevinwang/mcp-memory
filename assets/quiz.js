// Reusable retrieval-practice quiz widget.
//
// Usage:
//   <quiz-block data-explain="Why the right answer is right.">
//     <p class="q">Question text?</p>
//     <button data-correct>First answer</button>
//     <button>Second answer</button>
//     <button>Third answer</button>
//   </quiz-block>
//
// One button carries `data-correct`. Clicking gives immediate feedback:
// correct answers turn green, wrong answers red, and the block locks until
// the user clicks the correct one (wrong clicks stay visible as attempts).

class QuizBlock extends HTMLElement {
  connectedCallback() {
    const buttons = [...this.querySelectorAll("button")];
    const feedback = document.createElement("p");
    feedback.className = "feedback";
    this.appendChild(feedback);
    let attempts = 0;

    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("correct") || btn.classList.contains("wrong")) {
          return;
        }
        if (btn.hasAttribute("data-correct")) {
          btn.classList.add("correct");
          feedback.className = "feedback good";
          const praise = attempts === 0 ? "Correct, first try. " : "Correct. ";
          feedback.textContent = praise + (this.dataset.explain ?? "");
          for (const b of buttons) b.disabled = true;
        } else {
          btn.classList.add("wrong");
          attempts += 1;
          feedback.className = "feedback bad";
          feedback.textContent = "Not quite — try again before checking the source.";
        }
      });
    }
  }
}

customElements.define("quiz-block", QuizBlock);
