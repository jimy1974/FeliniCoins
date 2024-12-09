document.addEventListener('DOMContentLoaded', () => {
    

    const startGameButton = document.getElementById('start-game');

    if (startGameButton) {
        startGameButton.addEventListener('click', () => {
            window.location.href = '/auth/google';
        });
    }
    
    
    console.log("DOM fully loaded and parsed. Creating stars...");
    const starContainer = document.getElementById('star-container');

    if (!starContainer) {
        console.error("Star container not found!");
        return;
    }

    function createStar() {
        const star = document.createElement('div');
        star.style.position = 'absolute';
        star.style.width = `${Math.random() * 3}px`;
        star.style.height = `${Math.random() * 3}px`;
        star.style.backgroundColor = 'rgba(255,255,255,0.8)';
        star.style.borderRadius = '50%';
        star.style.left = `${Math.random() * 100}%`;
        star.style.top = `${Math.random() * 100}%`;

        // Apply animation
        star.style.animation = `twinkle ${2 + Math.random() * 3}s ${Math.random() * 2}s infinite`;

        // Append to container
        const starContainer = document.getElementById('star-container');
        starContainer.appendChild(star);
    }


    for (let i = 0; i < 200; i++) {
        createStar();
    }
});
