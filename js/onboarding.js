export class OnboardingCarousel {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.currentSlide = 0;
    this.totalSlides = 4;
    this.onFinish = options.onFinish || (() => {});
  }

  init() {
    if (!this.container) return;
    this.render();
    this.attachEvents();
  }

  goToSlide(index) {
    if (index >= 0 && index < this.totalSlides) {
      this.currentSlide = index;
      this.render();
      this.attachEvents();
    } else if (index >= this.totalSlides) {
      this.onFinish();
    }
  }

  next() {
    this.goToSlide(this.currentSlide + 1);
  }

  prev() {
    this.goToSlide(this.currentSlide - 1);
  }

  render() {
    const slides = [
      ['Review Every Change','Open a complete before-and-after comparison. Approve applies only the reviewed file if its project, content and revision still match. Reject and Cancel leave source unchanged.'],
      ['Edit Locally','Use Code and Files & projects to create or import a workspace. Saves stay in this browser. Export important work before installing an offline update or moving to another origin.'],
      ['Shape Your Workspace','Open Agents & Tools to find local Skills, Commands, Projects and connection details. Cloud synchronization and agent execution are not connected.'],
      ['Prototype Safely','The optional demo workbench labels its replies SIMULATED. It does not contact an AI provider, execute code, or create remote changes.']
    ];
    this.container.innerHTML = `<section class="help-card premium-page"><img src="images/melly-192.png" alt="Melly IDE orbital icon" width="64" height="64"><h1>${slides[this.currentSlide][0]}</h1><p>${slides[this.currentSlide][1]}</p><div class="onboarding-dots" role="group" aria-label="Help topics">${slides.map((_,i)=>`<button class="dot-btn ${i===this.currentSlide?'active':''}" data-index="${i}" aria-label="Topic ${i+1}" aria-current="${i===this.currentSlide?'step':'false'}">${i+1}</button>`).join('')}</div><button id="onboardingContinueBtn" class="primary-button">${this.currentSlide===3?'Open local tools':'Next topic'}</button></section>`;
  }

  attachEvents() {
    const continueBtn = this.container.querySelector('#onboardingContinueBtn');
    const dots = this.container.querySelectorAll('.dot-btn');
    const expandBtn = this.container.querySelector('#mockupExpandCode');

    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this.next();
      });
    }

    dots.forEach(d => {
      d.addEventListener('click', () => {
        this.goToSlide(parseInt(d.dataset.index, 10));
      });
    });

    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        this.next();
      });
    }

    // Touch swipe gesture support for mobile swiping
    if (this.touchBound) return;
    this.touchBound = true;
    let touchStartX = 0;
    this.container.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    this.container.addEventListener('touchend', (e) => {
      const touchEndX = e.changedTouches[0].screenX;
      if (touchStartX - touchEndX > 50) {
        this.next();
      } else if (touchEndX - touchStartX > 50) {
        this.prev();
      }
    }, { passive: true });
  }
}
