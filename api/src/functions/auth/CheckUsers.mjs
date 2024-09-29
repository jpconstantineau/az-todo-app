export default class CheckUsers{
    constructor() {

        }

        GetUserDetails(request) {
            let object= {}
            var  user =  { "userId"         : "", 
                            "userDetails"   : "",
                            "authorized"    : false }   
            try
            {
                const header = request.headers.get('x-ms-client-principal');
                const encoded = Buffer.from(header, 'base64');
                let decoded = encoded.toString('ascii');
                object= JSON.parse(decoded)
            }
            catch (err)
            {
                return user
            }
            switch (object.identityProvider)
            {
                case "github":
                    user.authorized = true
                    user.userId = object.userId
                    user.userDetails = object.userDetails
                    break  
                default:
                    user.authorized = false   
            }
            return user
        }               
}