import pkg from '@azure/functions';
const { app, HttpResponse } = pkg;

app.http('navbar', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'navbar',
    handler: async (request, context) => {
       
        context.log(`Http function processed request for url "${request.url}"`);
        context.log(`Invocation ID: "${context.invocationId}"`);       
        context.log(`Http headers "${JSON.stringify(request.headers)}"`);
        const data = `
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
      <div class="container">
        <a class="navbar-brand" href="#">Navbar</a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarSupportedContent" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Toggle navigation">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarSupportedContent">
          <ul class="navbar-nav me-auto mb-2 mb-lg-0">
            <li class="nav-item">
              <a class="nav-link active" aria-current="page" href="#">Home</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="#">Link</a>
            </li>
            <li class="nav-item dropdown">
              <a class="nav-link dropdown-toggle" href="#" id="navbarDropdown" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                Dropdown
              </a>
              <ul class="dropdown-menu" aria-labelledby="navbarDropdown">
                <li><a class="dropdown-item" href="#">Action</a></li>
                <li><a class="dropdown-item" href="#">Another action</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item" href="#">Something else here</a></li>
              </ul>
            </li>
            <li class="nav-item">
              <a class="nav-link disabled">Disabled</a>
            </li>
          </ul>
          <form class="d-flex" role="search">
            <input class="form-control me-2" type="search" placeholder="Search" aria-label="Search">
            <button class="btn btn-outline-success" type="submit">Search</button>
          </form>
        </div>
      </div>
    </nav>

        `;

        const response = new HttpResponse({ status: 200, 
            body: data
        });
        response.headers.set('content-type', 'text/html; charset=utf-8');

        return response;
            
    }
});

app.http('main', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'main',
    handler: async (request, context) => {
       
        context.log(`Http function processed request for url "${request.url}"`);
        context.log(`Invocation ID: "${context.invocationId}"`);       
        context.log(`Http headers "${JSON.stringify(request.headers)}"`);
        const data = `
    <div class="container my-5">
      <h1>Hello, world!</h1>
      <div class="col-lg-8 px-0">
        <p class="fs-5">You've successfully loaded up the Bootstrap starter example. It includes <a href="https://getbootstrap.com/">Bootstrap 5</a> via the <a href="https://www.jsdelivr.com/package/npm/bootstrap">jsDelivr CDN</a> and includes an additional CSS and JS file for your own code.</p>
        <p>Feel free to download or copy-and-paste any parts of this example.</p>

        <hr class="col-1 my-4">

        <a href="https://getbootstrap.com" class="btn btn-primary">Read the Bootstrap docs</a>
        <a href="https://github.com/twbs/examples" class="btn btn-secondary">View on GitHub</a>


        </div>
    </div>

        `;

        const response = new HttpResponse({ status: 200, 
            body: data
        });
        response.headers.set('content-type', 'text/html; charset=utf-8');

        return response;
            
    }
});
