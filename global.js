// Ortak Header Hazırlayıcı
function getAdminHeaders() {
    return {
        'Content-Type': 'application/json',
        'x-admin-id': localStorage.getItem('userId'),
        'x-admin-name': localStorage.getItem('fullName')
    };
}

// Örnek Kullanım (finans.html veya diğer sayfalar):
async function herhangiBirIslem(id) {
    await fetch(`/api/ornek/${id}`, {
        method: 'DELETE',
        headers: getAdminHeaders() // Tek satırla tüm kimlik bilgilerini gönderir
    });
}